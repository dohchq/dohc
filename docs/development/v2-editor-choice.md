# v2 Editor Choice

**Decision:** Tiptap OSS-only remains the default for Phase 1.

## Non-Negotiables

- Y.Doc is canonical.
- Markdown export/import must be deterministic.
- Core dohc must not depend on Tiptap Cloud, Tiptap AI Toolkit, Tiptap Comments, Tiptap Tracked Changes, or closed/pro/private Tiptap packages.
- Hocuspocus must be self-hosted outside Tiptap's platform.
- dohc AI edits must use repo-owned semantic operations, not a vendor AI toolkit.

## Why Tiptap First

- It is the lowest-risk migration from the current Milkdown/Crepe editor because both sit in the ProseMirror world.
- It has established Y.js collaboration support.
- Its markdown extension APIs are a direct fit for dohc's projection layer, where every rich construct needs deterministic parse/render behavior.
- It keeps Phase 1 focused on the real pivot: Y.Doc canonical state, Hocuspocus sync, and offline merge.

## Why Not Tiptap Paid AI

Tiptap's paid AI tooling is not dohc's core advantage. dohc should own the AI editing contract: semantic operations like `replaceRange`, `insertAfterHeading`, `rewriteSection`, and `applySuggestion` that operate through Hocuspocus against canonical Y.Doc state.

That makes dohc better for its own purpose than a generic editor AI toolkit: every AI action can understand atoms, wikilinks, file IDs, projections, local file sync, permissions, and self-hosting.

## Why Lexical Remains The Escape Hatch

- Lexical is excellent for deeply custom, text-first editing surfaces.
- It may be better if Tiptap's OSS markdown APIs cannot represent dohc constructs without paid/pro dependencies.
- It currently adds more custom glue risk for Yjs, markdown import/export, current ProseMirror plugins, and desktop/mobile parity.

## Stop/Go Test

Tiptap passes Phase 0/1.1 if every required dohc construct can be specified as an OSS Tiptap extension with deterministic markdown parse/render behavior.

Tiptap fails if any required construct needs paid/pro/private Tiptap features or hidden non-markdown state. If that happens, stop before Phase 1.1 implementation and switch the v2 plan to Lexical.

## Package Guardrail

Phase 0 searched for likely paid/pro Tiptap package names:

```bash
rg -n "@tiptap-pro|tiptap-pro|tiptap-ai|@tiptap/extension-ai|tracked-changes|comments" package.json pnpm-lock.yaml apps packages docs/development
```

Result: no core dependency was found. The only hits were planning text and unrelated comments/tests.
