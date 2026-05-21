# Testing

```bash
cd /home/ice/dev/dohc
pnpm typecheck    # tsc --noEmit across workspaces
pnpm test         # vitest run (src/** in node, convex/** in edge-runtime)
pnpm build        # vite build (TanStack Start + Nitro)
```

## Test surfaces

- **`src/**/*.test.ts`** — pure-logic units (parsers, scorers, tree
  nav, sanitizer, formula eval) run in the `node` environment.
- **`convex/**/*.test.ts`** — Convex functions tested with `convex-test`
  in the `edge-runtime` environment (mocked identity, no live
  deployment, no auth hole). This is the safe backend test path.
- **`src/__tests__/brandNoLegacy.test.ts`** — the rebrand guard. Scans
  `src`, `convex`, `public`, and `package.json` and fails on any legacy
  product identity (the old brand names). Keep its whitelist empty.
- **`src/eval/live.test.ts`** — a real model conformance gate, skipped
  unless `ANTHROPIC_API_KEY` is set (`ANTHROPIC_API_KEY=… pnpm --filter
  @dohc/app eval`). The offline scorer is covered by `score.test.ts`.

## Conventions

- Security/authz gate tests are structural — do not weaken them.
- When renaming a runtime namespace (CSS class, plugin key, MIME type,
  postMessage type), update the source and its test assertions in the
  same change so senders, receivers, and tests stay in lockstep.
