# @dohc/workspace-contracts

Shared TypeScript contracts for dohc workspace packages live here. The package
is intentionally light: it exposes durable type surfaces and small shared
contract helpers without depending on higher-level workspace implementations.

## Engine contract rename mapping

`src/engine.ts` is the source of truth for the extracted workspace-engine type
surface and its plan-to-shipped-name mapping.

| Plan / matrix symbol | Shipped engine contract symbol | Status | Notes |
| --- | --- | --- | --- |
| WorkspaceObject | FileObjectRecord | adopted | Shape differs from the plan matrix; this is the engine's real shipped record. |
| WorkspaceVersion | VersionRecord + VersionKind | adopted | Version kind remains a separate union. |
| HistoryMoment | VersionedTextMoment + VersionedTextMomentSummary | adopted | Full moment payload and summary/list row are separate shapes. |
| ConflictRecord | VersionedTextConflictRecord | adopted | Uses the engine's shipped text-conflict record. |
| ChatThread | ChatThread | adopted | Name unchanged. |
| ThreadMessage | ChatMessage | renamed | Engine ships messages under the chat-specific name. |
| WorkspaceLinkRef | LinkedChatFileRef | partial | Only the chat-file link case is implemented; a general link-ref vocabulary is not implemented. |
| VersionRef | Not implemented | not implemented | The engine currently uses plain version ids (VersionId) plus ad hoc fork-related fields where needed. |
| Phase0EffectivePolicyInput / Phase0EffectivePolicyResult | WorkspaceSearchPolicy + classifyEngineFilePath | partial | Covers the search/capture visibility surface only, not a general effective-policy hook. |
| WorkspaceEvent / DurabilityEvent | Not implemented | not implemented | The engine coalesces writes directly into moments (VersionedTextMoment) instead of emitting a separate durability/event log. |

The extraction is type-only: no zod schema mirrors were added for the engine
surface in this slice. `ChangeAuthor` and its branded `NonEmptyLocalAuthorLabel`
are canonically owned by this package and re-exported by
`@dohc/workspace-core`. The history/provenance shapes embedded in the
`VersionedFileWorkspace` surface are structural copies (this package cannot
depend on `@dohc/workspace-core`/`@dohc/workspace-history` without a cycle),
pinned to the real types by compile checks in
`packages/workspace-engine/src/engineContracts.compile.ts`.
