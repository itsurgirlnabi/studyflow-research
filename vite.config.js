import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        participant: resolve(projectRoot, 'index.html'),
        researcher: resolve(projectRoot, 'researcher.html'),
      },
    },
  },
});
