# create-reflow

Open-source web configurator for the [Naya Create](https://github.com/create-collective) split keyboard — a community successor to NayaFlow, talking to the keyboard directly over USB CDC (Web Serial), no host bridge required.

Monorepo (pnpm workspace):

- **`sdk/`** — `@create-reflow/sdk`: pure TypeScript protocol + state core. Wire protocol (CDC frames, keymap T-records, LED map, settings, modules), draft/queue model, snapshot import/export with schema migrations, auto-backup store, troubleshooting recipe engine with a runtime wire-guard. No React, no DOM — runs in browser and Node.
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

## License

MIT — see [LICENSE](LICENSE).
