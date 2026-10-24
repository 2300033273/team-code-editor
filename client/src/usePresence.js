import { useEffect, useRef, useState } from 'react';
import { wsBase } from './api.js';

// Keeps one WebSocket open to the server so we know who is online right now,
// and tells the server which project this tab is looking at.
export function usePresence(token, projectId) {
  const [users, setUsers] = useState([]);
  const [projectsVersion, setProjectsVersion] = useState(0);
  const wsRef = useRef(null);
  const whereRef = useRef(projectId);
  whereRef.current = projectId;

  useEffect(() => {
    if (!token) return undefined;
    let closed = false;
    let retry = 0;
    let timer;

    const connect = () => {
      const ws = new WebSocket(`${wsBase()}/presence?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        ws.send(JSON.stringify({ type: 'where', projectId: whereRef.current || null }));
      };
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data);
          if (m.type === 'online') setUsers(m.users);
          if (m.type === 'projects-changed') setProjectsVersion((v) => v + 1);
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        retry += 1;
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry, 15000));
      };
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [token]);

  useEffect(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'where', projectId: projectId || null }));
  }, [projectId]);

  return { users, projectsVersion };
}
