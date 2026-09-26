import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { buildClientMetadata } from './src/scopes.js';

/**
 * The headers Firebase Hosting sends for every path, so `npm run preview` runs the build
 * under the same Content-Security-Policy and other headers as production.
 */
function productionHeaders() {
  const { hosting } = JSON.parse(readFileSync('./firebase.json', 'utf8'));
  const rule = hosting.headers.find((h) => h.source === '**');
  return Object.fromEntries((rule?.headers ?? []).map(({ key, value }) => [key, value]));
}

// Origin the production build is served from. PR preview deploys rewrite this origin in
// the generated file to the preview channel's URL.
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://bye-sky.web.app';

/** Emits client-metadata.json from the same source the OAuth client uses at runtime. */
function clientMetadataPlugin() {
  return {
    name: 'byesky-client-metadata',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'client-metadata.json',
        source: JSON.stringify(buildClientMetadata(SITE_ORIGIN), null, 2) + '\n',
      });
    },
  };
}

export default defineConfig({
  plugins: [clientMetadataPlugin()],
  preview: {
    host: '127.0.0.1',
    headers: productionHeaders(),
  },
  build: {
    // The lazily-loaded atproto.js chunk is dominated by @atproto/api's generated lexicon
    // schemas (~650 kB minified, ~115 kB gzip), which can't be split further. It's only
    // fetched once a session exists, so raise the warning threshold to just above it.
    chunkSizeWarningLimit: 700,
  },
});
