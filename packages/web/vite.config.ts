import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Consume the shared protocol package straight from source (no build step).
      '@gsm/protocol': fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      input: {
        // Two independent pages: the monitor (index) and the dock-strip deck.
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        deck: fileURLToPath(new URL('./deck.html', import.meta.url)),
      },
    },
  },
  server: {
    host: '0.0.0.0', // reachable across the LAN, like the game's own dev server
    port: 5180,
    strictPort: false,
  },
});
