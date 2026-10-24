import { useEffect, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { python } from '@codemirror/lang-python';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { oneDark } from '@codemirror/theme-one-dark';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { api, wsBase, LANG_LABELS } from './api.js';
import { Avatar } from './Dashboard.jsx';

const langExtension = (lang) => (lang === 'python' ? python() : lang === 'java' ? java() : cpp());

const STATUS_TEXT = {
  ok: 'Finished successfully',
  compile_error: 'Compilation failed',
  runtime_error: 'Program exited with an error',
  timeout: 'Time limit exceeded',
  output_limit: 'Too much output (stopped)',
  error: 'Could not run',
  running: 'Running…',
};

export default function Editor({ projectId, auth, online, onLogout }) {
  const [project, setProject] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [language, setLanguage] = useState('python');
  const [conn, setConn] = useState('connecting');
  const [peers, setPeers] = useState([]);
  const [runState, setRunState] = useState(null);
  const [runError, setRunError] = useState('');
  const [stdin, setStdin] = useState('');

  const editorEl = useRef(null);
  const metaRef = useRef(null);
  const runRef = useRef(() => {});

  // 1) make sure the project exists
  useEffect(() => {
    api(`/api/projects/${projectId}`, { token: auth.token })
      .then(setProject)
      .catch((e) => {
        if (e.status === 401) onLogout();
        else setLoadError(e.message);
      });
  }, [projectId, auth.token, onLogout]);

  // 2) connect the shared document + editor
  useEffect(() => {
    if (!project) return undefined;

    const ydoc = new Y.Doc();
    const provider = new WebsocketProvider(`${wsBase()}/yjs`, projectId, ydoc, {
      params: { token: auth.token },
    });
    const ytext = ydoc.getText('code');
    const meta = ydoc.getMap('meta');
    const runMap = ydoc.getMap('run');
    metaRef.current = meta;

    const color = auth.user.color;
    provider.awareness.setLocalStateField('user', { name: auth.user.username, color, colorLight: `${color}33` });

    const langCompartment = new Compartment();
    const initialLang = meta.get('language') || project.language;
    setLanguage(initialLang);

    const view = new EditorView({
      parent: editorEl.current,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          keymap.of([
            ...yUndoManagerKeymap,
            { key: 'Mod-Enter', run: () => (runRef.current(), true) },
          ]),
          basicSetup,
          oneDark,
          EditorView.theme({
            '&': { height: '100%', fontSize: '15px' },
            '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
          }),
          langCompartment.of(langExtension(initialLang)),
          yCollab(ytext, provider.awareness),
        ],
      }),
    });

    const onMeta = () => {
      const lang = meta.get('language');
      if (!lang) return;
      setLanguage(lang);
      view.dispatch({ effects: langCompartment.reconfigure(langExtension(lang)) });
    };
    meta.observe(onMeta);

    const onRun = () => setRunState(runMap.get('state') || null);
    runMap.observe(onRun);
    onRun();

    const onStatus = ({ status }) => setConn(status); // 'connecting' | 'connected' | 'disconnected'
    provider.on('status', onStatus);
    provider.on('sync', onMeta);

    const updatePeers = () => {
      const seen = new Map();
      provider.awareness.getStates().forEach((s, clientId) => {
        if (s.user) seen.set(s.user.name, { ...s.user, self: clientId === provider.awareness.clientID });
      });
      setPeers([...seen.values()]);
    };
    provider.awareness.on('change', updatePeers);
    updatePeers();

    return () => {
      provider.awareness.off('change', updatePeers);
      meta.unobserve(onMeta);
      runMap.unobserve(onRun);
      view.destroy();
      provider.destroy();
      ydoc.destroy();
    };
  }, [project, projectId, auth.token, auth.user.color, auth.user.username]);

  const running = runState?.status === 'running';

  async function run() {
    if (running) return;
    setRunError('');
    try {
      await api(`/api/projects/${projectId}/run`, { token: auth.token, method: 'POST', body: { stdin } });
    } catch (e) {
      setRunError(e.message);
    }
  }
  runRef.current = run;

  function changeLanguage(lang) {
    metaRef.current?.set('language', lang); // syncs to everyone
  }

  if (loadError) {
    return (
      <div className="page center">
        <div className="card">
          <p>{loadError}</p>
          <a className="btn" href="#/">
            Back to projects
          </a>
        </div>
      </div>
    );
  }

  const others = online.filter((u) => u.projectId === projectId);

  return (
    <div className="editor-page">
      <header className="topbar">
        <div className="row gap">
          <a className="btn" href="#/">
            ← Projects
          </a>
          <strong>{project?.name || 'Loading…'}</strong>
          <span className={`pill ${conn}`}>{conn === 'connected' ? 'Live · saved' : conn === 'connecting' ? 'Connecting…' : 'Offline – reconnecting'}</span>
        </div>
        <div className="row gap">
          <div className="row peers" title="People in this file right now">
            {peers.map((p) => (
              <Avatar key={p.name} user={p} size={28} />
            ))}
          </div>
          <span className="muted small">{peers.length} in this file</span>
          <select value={language} onChange={(e) => changeLanguage(e.target.value)} title="Language (changes for everyone)">
            {Object.entries(LANG_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <button className="btn run" onClick={run} disabled={running || conn !== 'connected'} title="Ctrl/Cmd + Enter">
            {running ? 'Running…' : '▶ Run'}
          </button>
        </div>
      </header>

      <div className="editor-body">
        <div className="editor-host" ref={editorEl} />

        <aside className="side">
          <div className="side-block">
            <div className="side-title">Input (stdin)</div>
            <textarea
              value={stdin}
              onChange={(e) => setStdin(e.target.value)}
              placeholder="Text your program reads (Scanner, input(), scanf, cin)…"
              spellCheck={false}
            />
          </div>

          <div className="side-block grow">
            <div className="side-title row between">
              <span>Output</span>
              {runState && runState.status !== 'running' && (
                <span className="muted small">
                  run by {runState.by}
                  {typeof runState.timeMs === 'number' ? ` · ${(runState.timeMs / 1000).toFixed(2)}s` : ''}
                </span>
              )}
            </div>
            <div className="output">
              {runError && <div className="error">{runError}</div>}
              {!runState && !runError && <div className="muted">Press Run (or Ctrl/Cmd + Enter). Everyone in this file sees the same output.</div>}
              {runState && (
                <>
                  <div className={`status s-${runState.status}`}>
                    {STATUS_TEXT[runState.status] || runState.status}
                    {runState.status === 'running' && runState.by ? ` (started by ${runState.by})` : ''}
                    {runState.status === 'runtime_error' && typeof runState.exitCode === 'number' ? ` (exit code ${runState.exitCode})` : ''}
                  </div>
                  {runState.message && <pre className="err-text">{runState.message}</pre>}
                  {runState.compileOutput && <pre className={runState.status === 'compile_error' ? 'err-text' : 'warn-text'}>{runState.compileOutput}</pre>}
                  {runState.stdout && <pre>{runState.stdout}</pre>}
                  {runState.stderr && <pre className="err-text">{runState.stderr}</pre>}
                </>
              )}
            </div>
          </div>

          <div className="side-block">
            <div className="side-title">Online ({online.length})</div>
            <div className="row wrap gap">
              {online.map((u) => (
                <span key={u.id} className="chip" title={u.projectId === projectId ? 'In this file' : 'Elsewhere in the app'}>
                  <Avatar user={u} size={18} />
                  {u.username}
                  {u.projectId === projectId ? ' ✎' : ''}
                </span>
              ))}
            </div>
            {others.length === 0 && <div className="muted small">You are the only one in this file.</div>}
          </div>
        </aside>
      </div>
    </div>
  );
}
