# Testing

```bash
cd /home/ice/dev/dohc
pnpm typecheck          # tsc --noEmit across workspaces
pnpm test               # vitest run across workspaces
pnpm test:desktop:e2e   # desktop Playwright suite (builds first)
```

## Test surfaces

- **`packages/*/src/**/*.test.ts`** — engine, contracts, core/fs/history/
  sync, and MCP unit/integration suites (the workspace engine suite is the
  data-integrity backbone; run it for any engine-adjacent change).
- **`apps/desktop/src/**/*.test.ts(x)`** — desktop main-process and
  renderer units (vitest, jsdom for renderer components).
- **`apps/desktop/e2e/*.spec.ts`** — Playwright E2E against the built
  Electron app (hermetic temp workspaces under the OS tmpdir).
- **`packages/brand`** — the rebrand guard; keep its whitelist empty.

## Conventions

- Security/authz gate tests are structural — do not weaken them.
- When renaming a runtime namespace (CSS class, plugin key, MIME type,
  postMessage type), update the source and its test assertions in the
  same change so senders, receivers, and tests stay in lockstep.
