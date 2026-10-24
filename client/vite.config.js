import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the React app runs on :5173 and forwards API + WebSocket
// traffic to the Node server on :4000, so you never deal with CORS locally.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/yjs': { target: 'http://localhost:4000', ws: true },
      '/presence': { target: 'http://localhost:4000', ws: true },
    },
  },
});
