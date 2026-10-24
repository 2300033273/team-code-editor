import { useEffect, useState } from 'react';
import { api } from './api.js';
import { usePresence } from './usePresence.js';
import Login from './Login.jsx';
import Dashboard from './Dashboard.jsx';
import Editor from './Editor.jsx';

function readRoute() {
  const m = window.location.hash.match(/^#\/p\/([\w-]+)/);
  return m ? { projectId: m[1] } : { projectId: null };
}

export default function App() {
  const [auth, setAuth] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('auth') || 'null');
    } catch {
      return null;
    }
  });
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // verify the saved login is still valid
  useEffect(() => {
    if (!auth) return;
    api('/api/me', { token: auth.token }).catch((e) => {
      if (e.status === 401) logout();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { users: online, projectsVersion } = usePresence(auth?.token, route.projectId);

  function login(data) {
    localStorage.setItem('auth', JSON.stringify(data));
    setAuth(data);
  }
  function logout() {
    localStorage.removeItem('auth');
    setAuth(null);
    window.location.hash = '#/';
  }

  if (!auth) return <Login onAuth={login} />;

  if (route.projectId) {
    return <Editor key={route.projectId} projectId={route.projectId} auth={auth} online={online} onLogout={logout} />;
  }
  return <Dashboard auth={auth} online={online} projectsVersion={projectsVersion} onLogout={logout} />;
}
