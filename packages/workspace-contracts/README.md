# @dohc/workspace-contracts

Shared TypeScript contracts for dohc workspace packages live here. The package
is intentionally light: it exposes durable type surfaces and small shared
contract helpers without depending on higher-level workspace implementations.

## Engine contracts

`src/engine.ts` holds the workspace-engine type surface. It is type-only: no zod
schema mirrors exist for it. `ChangeAuthor` and its branded
`NonEmptyLocalAuthorLabel` are owned by this package. `@dohc/workspace-core`
re-exports `ChangeAuthor` and uses the same label brand internally.
