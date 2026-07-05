# @dohc/workspace-contracts

Shared TypeScript contracts for dohc workspace packages live here. The package
is intentionally light: it exposes durable type surfaces and small shared
contract helpers without depending on higher-level workspace implementations.

## Engine contract rename mapping

`src/engine.ts` is the source of truth for the extracted workspace-engine type
surface and its plan-to-shipped-name mapping: see the JSDoc table on the
module header there. (The table used to be duplicated here verbatim; one
hand-maintained copy is enough.)

The extraction is type-only: no zod schema mirrors were added for the engine
surface in this slice. `ChangeAuthor` and its branded `NonEmptyLocalAuthorLabel`
are canonically owned by this package and re-exported by
`@dohc/workspace-core`. The history/provenance shapes embedded in the
`VersionedFileWorkspace` surface are structural copies (this package cannot
depend on `@dohc/workspace-core`/`@dohc/workspace-history` without a cycle),
pinned to the real types by compile checks in
`packages/workspace-engine/src/engineContracts.compile.ts`.
