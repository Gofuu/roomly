import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: { chunkSizeWarningLimit: 600 }, // main chunk is ~155 kB gzipped; FullCalendar is split out
  server: {
    port: 5173,
    // Proxy API + WebSocket traffic so the browser sees one origin (simple cookies, no CORS in dev).
    proxy: {
      '/api': 'http://localhost:4000',
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
});
