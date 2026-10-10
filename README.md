# create-reflow

Open-source web configurator for the [Naya Create](https://github.com/create-collective) split keyboard — a community successor to NayaFlow, talking to the keyboard directly over USB CDC (Web Serial), no host bridge required.

**Live: https://nemezzizz.github.io/create-reflow/** (GitHub Pages, auto-deployed from `main` by `.github/workflows/pages.yml`).

Monorepo (pnpm workspace):

- **`sdk/`** — `@create-reflow/sdk`: pure TypeScript protocol + state core. Wire protocol (CDC frames, keymap T-records, LED map, settings, modules), draft/queue model, OpenFlow-native layer import/export, auto-backup store, troubleshooting recipe engine with a runtime wire-guard. No React, no DOM — runs in browser and Node.
- **`client/`** — `@create-reflow/client`: React 19 + Vite UI. Bindings / LED Map / Modules / Behavior / Devices / Troubleshooting tabs, right-click key menu, flash queue with readback verify.

Protocol ground truth and research history live in the [naya-reflow](https://github.com/NemeZZiZZ/naya-reflow) repo and the [naya-create-kb](https://nemezzizz.github.io/naya-create-kb/) knowledge base; this repo is the production web client extracted from them.

## Develop

```sh
pnpm install
pnpm dev        # client dev server
pnpm build      # typecheck sdk + build client
```

Smoke tests (no hardware needed; the gate is 0 FAIL — the assert count grows with each new §-section):

```sh
cd client
./node_modules/.bin/rolldown --config scripts/rolldown.smoke.mjs && node /tmp/smoke.cjs
```

## File formats

Save and Import speak **OpenFlow layer JSON** (`.openflow-layer.json`,
`version: 1`, `kind: 'layer'`) — the same files the OpenFlow configurator
writes. One document per layer carries both key bindings and LED colors:
`Layer N` exports a single layer, **All layers** downloads all three. The
layer's animation is stamped from last-known device state (defaults to
`solid` when unknown).

- **Import / Restore** accept OpenFlow layer docs and create-reflow
  auto-backups only. Legacy formats (`naya-backup`, `naya-reflow` v1/v2,
  `naya-full-backup`) are rejected with a clean-break error naming the
  re-export path. Import diffs against live state and queues only what
  changed — including the per-layer animation when the file's `animationId`
  differs from last-known. Anything unwritable degrades to a skip plus a
  logged warning (LED strip/bay entries are colors-only and informational).
- **Auto-backups** (pre-flash restore points in localStorage) wrap OpenFlow
  layer docs in an internal container (`tool: 'create-reflow'`,
  `kind: 'backup'`). Per-key notes ride only in that internal container —
  OpenFlow files themselves never carry notes.

Known round-trip limitation: values outside the OpenFlow binding shape —
hold-tap term ≠ 200 ms, non-zero unknown flag bytes — have no slot in the
format and reset to defaults on import.

## License

MIT — see [LICENSE](LICENSE).
