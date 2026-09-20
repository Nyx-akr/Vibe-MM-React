import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Honour an assigned PORT so several dev servers can run side by side;
    // 5173 stays the default when nothing assigns one.
    port: Number(process.env.PORT) || 5173,
    proxy: {
      '/api': {
        target: 'https://vibe-mm-server.onrender.com/',
        changeOrigin: true
      },
      '/health': {
        target: 'https://vibe-mm-server.onrender.com/',
        changeOrigin: true
      }
    }
  }
});
