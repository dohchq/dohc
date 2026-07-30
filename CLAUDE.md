@AGENTS.md

# Claude-specific instructions

- Use pnpm. Do not use npm, Yarn, Bun, or another package manager.
- Do not start a development server. Assume the user already controls it.
- Run checks that match the changed surface. Do not run a full build unless the
  task requires build or packaging evidence.
- Avoid TypeScript `any`. Use it only when the boundary cannot be typed safely,
  and explain why in code.
- Prefer the smallest clear implementation that preserves dohc’s contracts.
