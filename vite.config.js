import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // The dev proxy targets the same local data server the app probes first
  // (src/services/api.js LOCAL_BASE), never the deployed one: a relative
  // /raw read in dev should hit the store your collector is writing.
  const env = loadEnv(mode, process.cwd(), '');
  const localApi = env.VITE_LOCAL_API_BASE || 'http://localhost:8787';

  return {
    plugins: [react()],
    server: {
      // Honour an assigned PORT so several dev servers can run side by side;
      // 5173 stays the default when nothing assigns one.
      port: Number(process.env.PORT) || 5173,
      proxy: {
        '/raw': { target: localApi, changeOrigin: true },
        '/health': { target: localApi, changeOrigin: true }
      }
    }
  };
});
