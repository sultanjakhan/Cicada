import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src',
  clearScreen: false,
  server: { strictPort: true, host: '127.0.0.1', port: 1420 },
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
});
