# Phase 1.5 Y.Awareness Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add collaborative cursor/selection presence through Y.Awareness while preventing restricted metadata leaks.

**Architecture:** The browser owns one `Awareness` instance per collaborative Y.Doc and passes it to the Hocuspocus provider plus Tiptap collaboration carets. Editable collaborators publish only safe display metadata. Read-only collaborators keep their local awareness state empty. Hocuspocus rechecks ACL before awareness handling, strips unknown payload fields, clears read-only publication attempts, and rejects revoked/expired connections.

---

## File Structure

- Modify: `apps/app/package.json` / `pnpm-lock.yaml` — add OSS caret and awareness protocol packages.
- Modify: `apps/app/src/editor-v2/hocuspocusProvider.ts` — create safe awareness helper and provider wiring.
- Create: `apps/app/src/editor-v2/hocuspocusProvider.awareness.test.ts` — client awareness adapter tests.
- Modify: `apps/app/src/components/AtomEditor.tsx` — install collaboration carets for editable collaborators.
- Modify: `apps/app/src/components/AtomEditor.lifecycle.test.ts` — mounted editor awareness/caret lifecycle coverage.
- Modify: `services/hocuspocus/src/hooks.ts` — server-side awareness ACL and payload sanitization.
- Modify: `services/hocuspocus/src/hooks.test.ts` — server awareness security tests.

## Task 1: Client Awareness Adapter

- [x] **Step 1: Write failing adapter tests**

Cover:
- editable collaborators publish only `{ user: { id, name, color } }`.
- read-only collaborators publish no local awareness state.
- the Hocuspocus provider receives the configured `Awareness` instance.

Run:

```bash
pnpm --filter @dohc/app exec vitest run src/editor-v2/hocuspocusProvider.awareness.test.ts
```

Expected before implementation: fails because `createDohcAwareness` does not exist.

- [x] **Step 2: Implement awareness helper and provider wiring**

Add `createDohcAwareness(ydoc, { publish, user })` and pass optional `awareness`, `onAwarenessUpdate`, and `onAwarenessChange` through `createDohcHocuspocusProvider`.

Run:

```bash
pnpm --filter @dohc/app exec vitest run src/editor-v2/hocuspocusProvider.awareness.test.ts src/editor-v2/hocuspocusProvider.test.ts
```

Expected after implementation: tests pass.

## Task 2: Editor Caret Wiring

- [x] **Step 1: Write mounted lifecycle coverage**

Extend `AtomEditor.lifecycle.test.ts` to prove a collaborative editable editor:
- creates one awareness instance with safe user metadata.
- passes that awareness instance into the provider.
- configures `@tiptap/extension-collaboration-caret` with the same awareness provider.
- includes the caret extension in the mounted editor.

Run:

```bash
pnpm --filter @dohc/app exec vitest run src/components/AtomEditor.lifecycle.test.ts
```

Expected before implementation: fails because the editor does not create awareness/carets.

- [x] **Step 2: Implement caret wiring**

Install `@tiptap/extension-collaboration-caret`, create the awareness object when collaboration is enabled, pass it to the provider, and install carets for editable collaborators.

Run:

```bash
pnpm --filter @dohc/app exec vitest run src/components/AtomEditor.lifecycle.test.ts src/editor-v2/hocuspocusProvider.awareness.test.ts src/editor-v2/hocuspocusProvider.test.ts
```

Expected after implementation: tests pass.

## Task 3: Server Awareness Gates

- [x] **Step 1: Write failing Hocuspocus tests**

Cover:
- awareness payloads are sanitized before broadcast.
- read-only connections cannot publish awareness.
- expired tokens reject awareness updates.
- revoked read access rejects awareness updates.

Run:

```bash
pnpm --filter @dohc/hocuspocus exec vitest run src/hooks.test.ts
```

Expected before implementation: fails because `beforeHandleAwareness` does not exist.

- [x] **Step 2: Implement server hook**

Add `beforeHandleAwareness` to:
- require live context.
- reject expired tokens.
- recheck read access.
- clear attempted read-only publication.
- strip unknown fields and retain only safe `user` plus cursor coordinates.

Run:

```bash
pnpm --filter @dohc/hocuspocus exec vitest run src/hooks.test.ts
pnpm --filter @dohc/hocuspocus run typecheck
```

Expected after implementation: tests and Hocuspocus typecheck pass.

## Verification

- [x] Client focused tests:

```bash
pnpm --filter @dohc/app exec vitest run src/components/AtomEditor.lifecycle.test.ts src/editor-v2/hocuspocusProvider.awareness.test.ts src/editor-v2/hocuspocusProvider.test.ts
```

- [x] Server tests:

```bash
pnpm --filter @dohc/hocuspocus exec vitest run src/hooks.test.ts
```

- [x] Server typecheck:

```bash
pnpm --filter @dohc/hocuspocus run typecheck
```

- [x] App typecheck:

```bash
pnpm --filter @dohc/app run typecheck
```

Phase 1.9 removed the legacy Milkdown/Crepe files that previously blocked app typecheck.

## Rollback Notes

- Remove `@tiptap/extension-collaboration-caret` and `y-protocols`.
- Remove `createDohcAwareness` and omit awareness from the provider config.
- Remove `beforeHandleAwareness` from Hocuspocus hooks.
- Collaborative editing still works without cursors because the Y.Doc transport path is independent of awareness.
