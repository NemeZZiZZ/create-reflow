// Rolldown config for the smoke bundle: plain rolldown CLI cannot resolve
// Vite's `?raw` suffix, so a tiny loader inlines *.svg?raw / *.json?raw as
// strings (same semantics as Vite; also fails the bundle if a file is
// missing).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export default {
  input: 'scripts/smoke.tsx',
  // codeSplitting:false keeps the bundle single-file (node /tmp/smoke.cjs):
  // the app-shortcuts loader's dynamic JSON import would otherwise split a
  // second chunk, which output.file forbids.
  output: { format: 'cjs', file: '/tmp/smoke.cjs', codeSplitting: false },
  plugins: [
    {
      name: 'raw-loader',
      resolveId(source, importer) {
        if (source.endsWith('?raw') && importer) {
          return resolve(dirname(importer), source.slice(0, -4)) + '?raw';
        }
        return null;
      },
      load(id) {
        if (id.endsWith('?raw')) {
          const text = readFileSync(id.slice(0, -4), 'utf8');
          return `export default ${JSON.stringify(text)};`;
        }
        return null;
      },
    },
  ],
};
