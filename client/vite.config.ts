import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on the LAN too: the game is played on phones pointed at this machine's IP.
    host: true,
    port: 5173,
    proxy: {
      '/socket.io': { target: 'http://localhost:3001', ws: true },
      '/img': { target: 'http://localhost:3001' },
    },
  },
});
