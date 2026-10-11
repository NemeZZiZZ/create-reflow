// Codegen: compact app-shortcuts index from the vendored source.
//   in:  client/src/data/app-shortcuts.source.json (verbatim vendor, MIT)
//   out: client/src/generated/app-shortcuts.json   (committed, deterministic)
// Run: node client/scripts/gen-app-shortcuts.mjs

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, "../src/data/app-shortcuts.source.json");
const outPath = join(here, "../src/generated/app-shortcuts.json");

const source = JSON.parse(readFileSync(srcPath, "utf8"));

const cats = [...new Set(Object.values(source.apps).map((app) => app.category))].sort((a, b) =>
  a.localeCompare(b),
);
const catIndex = new Map(cats.map((name, i) => [name, i]));

let total = 0;
let winAny = 0;
let macAny = 0;
let both = 0;
let missing = 0;

const apps = Object.keys(source.apps)
  .sort((a, b) => a.localeCompare(b))
  .map((name) => {
    const app = source.apps[name];
    const actions = Object.keys(app.actions).map((actionName) => {
      total++;
      const a = app.actions[actionName];
      const w = a.windows ?? null;
      const m = a.mac ?? null;
      const wChord = w?.chord ?? null;
      const wBytes = w?.bytes ?? null;
      const mChord = m?.chord ?? null;
      const mBytes = m?.bytes ?? null;
      const wOk = wChord !== null && wBytes !== null;
      const mOk = mChord !== null && mBytes !== null;
      if (w && !wOk) missing++;
      if (m && !mOk) missing++;
      if (wOk) winAny++;
      if (mOk) macAny++;
      if (wOk && mOk) both++;
      return [actionName, wChord, wBytes, mChord, mBytes, a.context ?? null];
    });
    return [name, catIndex.get(app.category), actions];
  });

const winOnly = winAny - both;
const macOnly = macAny - both;

console.log(`apps:         ${apps.length}`);
console.log(`categories:   ${cats.length}`);
console.log(`total:        ${total}`);
console.log(`windows-any:  ${winAny}`);
console.log(`mac-any:      ${macAny}`);
console.log(`both:         ${both}`);
console.log(`win-only:     ${winOnly}`);
console.log(`mac-only:     ${macOnly}`);
console.log(`missing:      ${missing}`);

if (missing !== 0) {
  console.error(`FAIL: ${missing} action entries missing chord or bytes (must be 0)`);
  process.exit(1);
}

const out = { v: 1, cats, apps };
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out));
console.log(`wrote ${outPath} (${JSON.stringify(out).length} bytes)`);
