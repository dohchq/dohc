## dohc web app notes

- This is the `@dohc/web` workspace package in the dohc monorepo: the dohc
  Cloud web client (sign-in, cloud workspace browsing/light editing, shared
  links). The desktop app (`apps/desktop`) is the primary client.
- The only backend is the Postgres `services/workspace-api` (Better Auth
  cookie sessions). All file operations go through the `DohcBackendClient`
  seam in `src/backend/` — never fetch API routes directly from components.
- Run commands from the repo root (`pnpm dev`, `pnpm test`, ...). Tests need
  Node 22.13.
- Brand identity is final: lowercase `dohc`, the drop-lobe mark, warm
  paper + graphite. There must be no legacy product identity in shipping
  source — `src/__tests__/brandNoLegacy.test.ts` enforces this.
- Preserve authorization and data ownership boundaries.
  See `../../docs/security/authz-boundaries.md`.
- Do not import Electron, `@dohc/desktop`, or Node-only workspace packages
  (`src/__tests__/cloudWebRole.test.tsx` enforces this).
