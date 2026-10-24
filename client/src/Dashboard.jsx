import { useCallback, useEffect, useState } from 'react';
import { api, LANG_LABELS, timeAgo } from './api.js';

export function Avatar({ user, size = 28 }) {
  return (
    <span
      className="avatar"
      title={user.username || user.name}
      style={{ background: user.color, width: size, height: size, fontSize: size * 0.45 }}
    >
      {(user.username || user.name || '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

export default function Dashboard({ auth, online, projectsVersion, onLogout }) {
  const [projects, setProjects] = useState([]);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('python');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setProjects(await api('/api/projects', { token: auth.token }));
    } catch (e) {
      if (e.status === 401) onLogout();
    } finally {
      setLoading(false);
    }
  }, [auth.token, onLogout]);

  // reload when anyone creates a project, and every 20s as a safety net
  useEffect(() => {
    load();
  }, [load, projectsVersion]);
  useEffect(() => {
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  async function create(e) {
    e.preventDefault();
    setError('');
    try {
      const p = await api('/api/projects', { token: auth.token, method: 'POST', body: { name, language } });
      setName('');
      window.location.hash = `#/p/${p.id}`;
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="logo">{'</>'}</span> Team Code Editor
        </div>
        <div className="row gap">
          <Avatar user={auth.user} />
          <span>{auth.user.username}</span>
          <button className="btn" onClick={onLogout}>
            Log out
          </button>
        </div>
      </header>

      <main className="dash">
        <section className="dash-main">
          <form className="card new-project" onSubmit={create}>
            <h3>New project</h3>
            <div className="row gap wrap">
              <input
                placeholder="Project name (e.g. Sorting lab)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                required
              />
              <select value={language} onChange={(e) => setLanguage(e.target.value)}>
                {Object.entries(LANG_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <button className="btn primary">Create &amp; open</button>
            </div>
            {error && <div className="error">{error}</div>}
          </form>

          <h3 className="section-title">Team projects</h3>
          {loading && <p className="muted">Loading…</p>}
          {!loading && projects.length === 0 && <p className="muted">No projects yet. Create the first one above.</p>}
          <div className="project-grid">
            {projects.map((p) => {
              const here = online.filter((u) => u.projectId === p.id);
              return (
                <a key={p.id} className="card project" href={`#/p/${p.id}`}>
                  <div className="row between">
                    <strong>{p.name}</strong>
                    <span className={`badge lang-${p.language}`}>{LANG_LABELS[p.language] || p.language}</span>
                  </div>
                  <div className="muted small">
                    by {p.createdByName} · edited {timeAgo(p.updatedAt)}
                  </div>
                  <div className="row gap here">
                    {here.length === 0 ? (
                      <span className="muted small">Nobody here right now</span>
                    ) : (
                      <>
                        {here.map((u) => (
                          <Avatar key={u.id} user={u} size={24} />
                        ))}
                        <span className="small live">{here.length} editing now</span>
                      </>
                    )}
                  </div>
                </a>
              );
            })}
          </div>
        </section>

        <aside className="card online-panel">
          <h3>
            Online now <span className="count">{online.length}</span>
          </h3>
          {online.length === 0 && <p className="muted small">Connecting…</p>}
          <ul className="online-list">
            {online.map((u) => {
              const proj = projects.find((p) => p.id === u.projectId);
              return (
                <li key={u.id}>
                  <span className="dot" />
                  <Avatar user={u} size={26} />
                  <div>
                    <div>
                      {u.username}
                      {u.id === auth.user.id && <span className="muted"> (you)</span>}
                    </div>
                    <div className="muted small">{proj ? `in ${proj.name}` : 'browsing projects'}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </aside>
      </main>
    </div>
  );
}
