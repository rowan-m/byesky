import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // The lazily-loaded atproto.js chunk is dominated by @atproto/api's generated lexicon
    // schemas (~650 kB minified, ~115 kB gzip), which can't be split further. It's only
    // fetched once a session exists, so raise the warning threshold to just above it.
    chunkSizeWarningLimit: 700,
  },
});
