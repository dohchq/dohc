<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## dohc app notes

- This is the `@dohc/web` workspace package in the dohc monorepo. Run
  commands from the repo root (`pnpm dev`, `pnpm test`, …).
- Brand identity is final: lowercase `dohc`, the drop-lobe mark, warm
  paper + graphite. There must be no legacy product identity in shipping
  source — `src/__tests__/brandNoLegacy.test.ts` enforces this.
- Preserve authorization, data ownership, and the Convex safety gates.
  See `../../docs/security/authz-boundaries.md`.
