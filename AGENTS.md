# AGENTS.md

Statement import: a test assignment fragment. The user picks a PDF/CSV statement, the app validates it on the device, uploads the raw bytes to the kit's local mock, follows the async job to a report of recurring charges, and deletes the import. Behaviour under failure (lost responses, relaunch, stale answers, failed deletes) matters more than screens.

## Rules

- **`kit/` is the unchanged candidate kit.** Never edit, format or lint it; README.md lists its sha256 sums. Use its server only through HTTP or `createMockServer` in tests.
- Expo SDK 58 (React Native 0.88). Read https://docs.expo.dev/versions/v58.0.0/ before touching an Expo API; install with `npx expo install`.
- Development builds only (expo-secure-store, NetInfo and other native modules). `ios/` and `android/` are generated and gitignored; adding a native module means rebuilding the dev client.
- User-facing text is Russian, written in place; the wording lives in `src/presentation/import-view.ts` and has tests.
- Logs go through `src/core/log.ts` only. Never log a file name, bytes, report items or idempotency keys; `console.log` elsewhere is a bug.
- Never claim more than the server confirmed: no "sent" before 202, no "ready" before a ready snapshot, no "deleted" before a GET returns `deleted` (a DELETE's own answer only ever moves the job to `deleting`).

## Commands

```bash
nvm use                # Node 24
npm start              # kit mock + Metro (scripts/dev.mjs); npm run ios / android to build
npm test               # engine against the real kit mock (node:test, TS type stripping)
npm run verify         # typecheck + lint + client tests + kit tests
```

## Layout

- `src/core/` — no React Native imports, runs in Node: file check, HTTP contract, state machine (`machine.ts`), engine (`engine.ts`), logger, storage port. Imports between core files use explicit `.ts` extensions and erasable TypeScript only (no enums, namespaces or parameter properties), because Node strips the types in tests.
- `src/platform/` — the device side of the ports: expo-file-system (private copy in Caches, `File.upload`), expo/fetch, the Keychain via expo-secure-store (this-device-only; wiped on a fresh install), NetInfo (reachability probe off: no external requests), the document picker, and the engine singleton.
- Persisted state is minimal by rule (`src/core/store.ts`): keys, job id, revision, size, format. Never the file name, a content hash or the report; the record is cleared once the operation is finished.
- `src/presentation/` — engine state → steps, notices and actions.
- `src/app/` — Expo Router: native tabs `(tabs)/(import)` and `(tabs)/(diagnostics)` (the second one and the tab bar are hidden outside `__DEV__`), each with its own header stack; `charge/[id]` is a sheet over the tabs.
- Motion goes through `src/components/motion.tsx` (`Appear`/`Shift`), haptics through `src/presentation/feedback.ts` (which change deserves which) and `src/platform/haptics.ts`.
- `metro.config.js` keeps `kit/` out of Metro: the mock rewrites `kit/.mock-state.json` on every request, and a watched write triggers a Fast Refresh in the app.
- `tests/` — `harness.ts` runs the engine against `createMockServer` on port 0 with temp state; its `Faults` (refuse / respond / lose / hold) simulate the network failures used in `faults.test.ts`.
