import express from 'express';
import cors from 'cors';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import yutils from 'y-websocket/bin/utils';

import * as store from './store.js';
import { runCode, LANGUAGES, TEMPLATES } from './runner.js';

const { setupWSConnection, setPersistence, getYDoc } = yutils;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4000);
const IS_PROD = process.env.NODE_ENV === 'production';

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (IS_PROD) {
    JWT_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn('[warn] JWT_SECRET is not set. Using a random one: everybody is logged out whenever the server restarts.');
  } else {
    JWT_SECRET = 'local-development-secret'; // fine on your own machine, never use in production
  }
}
// Do not let it leak into the environment of anything we spawn.
delete process.env.JWT_SECRET;

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN ? process.env.CLIENT_ORIGIN.split(',').map((s) => s.trim()) : true,
  }),
);

// ---------------------------------------------------------------- auth helpers
const signToken = (user) => jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '7d' });

function userFromToken(token) {
  try {
    const { sub } = jwt.verify(token, JWT_SECRET);
    return store.findUserById(sub) || null;
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const user = userFromToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!user) return res.status(401).json({ error: 'Please log in again.' });
  req.user = user;
  next();
}

// very small in-memory rate limiter
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > max;
}

// ---------------------------------------------------------------- auth routes
function validateCreds(username, password) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{3,20}$/.test(username)) {
    return 'Username must be 3-20 characters: letters, numbers, _ . -';
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 100) {
    return 'Password must be at least 6 characters.';
  }
  return null;
}

app.post('/api/register', async (req, res) => {
  if (rateLimit(`reg:${req.ip}`, 10, 60_000)) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  const { username, password } = req.body || {};
  const problem = validateCreds(username, password);
  if (problem) return res.status(400).json({ error: problem });
  if (store.findUserByName(username)) return res.status(409).json({ error: 'That username is already taken.' });
  const user = store.createUser(username, await bcrypt.hash(password, 10));
  res.json({ token: signToken(user), user: store.publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  if (rateLimit(`login:${req.ip}`, 15, 60_000)) return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  const { username, password } = req.body || {};
  const user = typeof username === 'string' ? store.findUserByName(username) : null;
  const ok = user && typeof password === 'string' && (await bcrypt.compare(password, user.passwordHash));
  if (!ok) return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: signToken(user), user: store.publicUser(user) });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: store.publicUser(req.user) }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------- projects
const withAuthor = (p) => ({ ...p, createdByName: store.findUserById(p.createdBy)?.username || 'unknown' });

app.get('/api/languages', requireAuth, (_req, res) => res.json(LANGUAGES));

app.get('/api/projects', requireAuth, (_req, res) => res.json(store.listProjects().map(withAuthor)));

app.post('/api/projects', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 60);
  const language = req.body?.language;
  if (!name) return res.status(400).json({ error: 'Give the project a name.' });
  if (!LANGUAGES[language]) return res.status(400).json({ error: 'Unknown language.' });
  const project = store.createProject({ name, language, createdBy: req.user.id });
  broadcastPresence({ type: 'projects-changed' });
  res.json(withAuthor(project));
});

app.get('/api/projects/:id', requireAuth, (req, res) => {
  const p = store.getProject(req.params.id);
  if (!p) return res.status(404).json({ error: 'Project not found.' });
  res.json(withAuthor(p));
});

// ---------------------------------------------------------------- run code
// Runs the code that is currently in the SHARED document (so everyone runs the
// same thing) and writes the result back into the shared document so every
// teammate sees the same output at the same time.
const running = new Set();

app.post('/api/projects/:id/run', requireAuth, async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found.' });
  if (rateLimit(`run:${req.user.id}`, 20, 60_000)) return res.status(429).json({ error: 'Slow down: max 20 runs per minute.' });
  if (running.has(project.id)) return res.status(409).json({ error: 'A run is already in progress for this project.' });

  const ydoc = getYDoc(project.id);
  const code = ydoc.getText('code').toString();
  const language = ydoc.getMap('meta').get('language') || project.language;
  const runMap = ydoc.getMap('run');
  const stdin = typeof req.body?.stdin === 'string' ? req.body.stdin.slice(0, 20_000) : '';

  running.add(project.id);
  runMap.set('state', { status: 'running', by: req.user.username, at: Date.now() });
  try {
    const result = await runCode({ language, code, stdin });
    runMap.set('state', { ...result, by: req.user.username, at: Date.now(), language });
    res.json({ ok: true });
  } finally {
    running.delete(project.id);
  }
});

// ---------------------------------------------------------------- Yjs persistence
const saveTimers = new Map();

function persistNow(docName, ydoc) {
  store.saveDocState(docName, Y.encodeStateAsUpdate(ydoc));
  store.touchProject(docName);
}

setPersistence({
  bindState: (docName, ydoc) => {
    const project = store.getProject(docName);
    const saved = store.loadDocState(docName);
    if (saved) {
      Y.applyUpdate(ydoc, saved);
    } else if (project) {
      // brand new project: start with a hello-world template
      ydoc.transact(() => {
        ydoc.getText('code').insert(0, TEMPLATES[project.language] || '');
        ydoc.getMap('meta').set('language', project.language);
      });
      persistNow(docName, ydoc);
    }
    // forget any stale "running" status left by a crash
    const st = ydoc.getMap('run').get('state');
    if (st && st.status === 'running') ydoc.getMap('run').delete('state');

    ydoc.getMap('meta').observe(() => {
      const lang = ydoc.getMap('meta').get('language');
      if (LANGUAGES[lang]) store.touchProject(docName, { language: lang });
    });
    ydoc.on('update', () => {
      clearTimeout(saveTimers.get(docName));
      saveTimers.set(
        docName,
        setTimeout(() => persistNow(docName, ydoc), 1000),
      );
    });
  },
  writeState: async (docName, ydoc) => {
    clearTimeout(saveTimers.get(docName));
    persistNow(docName, ydoc);
  },
});

// ---------------------------------------------------------------- presence (who is online)
const presenceWss = new WebSocketServer({ noServer: true });
const sessions = new Map(); // ws -> { user, projectId }

function onlineUsers() {
  const byUser = new Map();
  for (const { user, projectId } of sessions.values()) {
    const entry = byUser.get(user.id) || { ...store.publicUser(user), projectId: null, tabs: 0 };
    entry.tabs += 1;
    if (projectId) entry.projectId = projectId; // where they are working right now
    byUser.set(user.id, entry);
  }
  return [...byUser.values()];
}

function broadcastPresence(extra) {
  const msg = JSON.stringify(extra || { type: 'online', users: onlineUsers() });
  for (const ws of sessions.keys()) if (ws.readyState === 1) ws.send(msg);
}
const broadcastOnline = () => broadcastPresence();

presenceWss.on('connection', (ws, _req, user) => {
  sessions.set(ws, { user, projectId: null });
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'where') {
        const s = sessions.get(ws);
        if (s) s.projectId = typeof m.projectId === 'string' ? m.projectId : null;
        broadcastOnline();
      }
    } catch {
      /* ignore bad messages */
    }
  });
  ws.on('close', () => {
    sessions.delete(ws);
    broadcastOnline();
  });
  broadcastOnline();
});

// drop dead connections (closed laptop lids, lost wifi) so "online" stays truthful
setInterval(() => {
  for (const ws of sessions.keys()) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);

// ---------------------------------------------------------------- Yjs websocket
const yjsWss = new WebSocketServer({ noServer: true });
yjsWss.on('connection', (ws, req, docName) => {
  setupWSConnection(ws, req, { docName });
});

// ---------------------------------------------------------------- static client (production)
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api\/|yjs\/|presence).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
} else if (IS_PROD) {
  console.warn('[warn] client/dist not found. Run "npm run build" first.');
}

// ---------------------------------------------------------------- start
const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const user = userFromToken(url.searchParams.get('token') || '');
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  if (url.pathname === '/presence') {
    presenceWss.handleUpgrade(req, socket, head, (ws) => presenceWss.emit('connection', ws, req, user));
  } else if (url.pathname.startsWith('/yjs/')) {
    const docName = decodeURIComponent(url.pathname.slice('/yjs/'.length));
    if (!store.getProject(docName)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      return socket.destroy();
    }
    yjsWss.handleUpgrade(req, socket, head, (ws) => yjsWss.emit('connection', ws, req, docName));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Team code editor server running on http://localhost:${PORT}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    // save every open document before exiting
    try {
      for (const [name, doc] of yutils.docs) persistNow(name, doc);
    } catch (err) {
      console.error('Could not save open documents:', err.message);
    }
    store.flushDb();
    process.exit(0);
  });
}
