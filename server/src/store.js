// Tiny file-based store (no native database needed, works on any OS).
//   data/db.json        -> users + projects
//   data/docs/<id>.bin  -> saved Yjs document (the shared code) for each project
// For a bigger deployment, replace this file with PostgreSQL/MySQL calls.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DOCS_DIR = path.join(DATA_DIR, 'docs');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(DOCS_DIR, { recursive: true });
try {
  fs.chmodSync(DATA_DIR, 0o700);
} catch {
  /* not supported on this OS */
}

let db = { users: [], projects: [] };
try {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db.users ||= [];
  db.projects ||= [];
} catch {
  /* first run */
}

let saveTimer = null;
function saveDb() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushDb, 200);
}
export function flushDb() {
  clearTimeout(saveTimer);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const COLORS = ['#f97316', '#22c55e', '#3b82f6', '#e11d48', '#a855f7', '#14b8a6', '#eab308', '#ec4899', '#06b6d4', '#84cc16'];

const newId = () => crypto.randomBytes(6).toString('hex');

// ---------- users ----------
export function findUserByName(username) {
  const u = String(username).toLowerCase();
  return db.users.find((x) => x.username.toLowerCase() === u);
}
export function findUserById(id) {
  return db.users.find((x) => x.id === id);
}
export function createUser(username, passwordHash) {
  const user = {
    id: newId(),
    username,
    passwordHash,
    color: COLORS[db.users.length % COLORS.length],
    createdAt: Date.now(),
  };
  db.users.push(user);
  saveDb();
  return user;
}
export const publicUser = (u) => ({ id: u.id, username: u.username, color: u.color });

// ---------- projects ----------
export function listProjects() {
  return [...db.projects].sort((a, b) => b.updatedAt - a.updatedAt);
}
export function getProject(id) {
  return db.projects.find((p) => p.id === id);
}
export function createProject({ name, language, createdBy }) {
  const p = { id: newId(), name, language, createdBy, createdAt: Date.now(), updatedAt: Date.now() };
  db.projects.push(p);
  saveDb();
  return p;
}
export function touchProject(id, patch = {}) {
  const p = getProject(id);
  if (!p) return;
  Object.assign(p, patch, { updatedAt: Date.now() });
  saveDb();
}

// ---------- documents (Yjs state) ----------
const docPath = (id) => path.join(DOCS_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.bin`);

export function loadDocState(id) {
  try {
    return fs.readFileSync(docPath(id));
  } catch {
    return null;
  }
}
export function saveDocState(id, bytes) {
  const tmp = docPath(id) + '.tmp';
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, docPath(id));
}

process.on('SIGTERM', () => {
  flushDb();
});
