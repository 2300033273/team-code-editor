// VITE_API_URL is empty when the server also serves the client (Render-only
// deploy, or local dev through the Vite proxy). Set it only when the client is
// hosted somewhere else (for example Vercel) and the server lives on Render.
const API = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export function wsBase() {
  if (API) return API.replace(/^http/, 'ws');
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}

export async function api(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const LANG_LABELS = { python: 'Python', java: 'Java', c: 'C', cpp: 'C++' };

export function timeAgo(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
