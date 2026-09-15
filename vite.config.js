import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
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
