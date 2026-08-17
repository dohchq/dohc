---
id: product-spec
title: dohc Product Spec
---

# dohc product spec

dohc is a local-first Electron app. A workspace is a folder the user owns.
The desktop app requires the Rust workspace engine and does not require a
backend.

## Workspace model

- Files and folders are the visible source.
- `.dohc/engine/engine.db` stores engine state for the workspace.
- The engine records versions, moments, search data, chats, sync operations,
  and document collaboration state.
- Secret-classified files keep plaintext out of history, search, export, and
  relay payloads.
- `shared-with-me/` contains read-only projections of received shares.

## Product surfaces

- **Explorer:** browse, create, move, import, export, and delete workspace
  files.
- **Editor:** edit Markdown with Tiptap and Yjs, or edit source directly.
- **Chat:** talk with agents and people in channels, threads, and direct
  messages.
- **History:** inspect moments, versions, comparisons, conflicts, and restores.
- **Search and graph:** find content and follow workspace links.
- **Plugins:** extend dohc with views, panels, and web apps, including the
  Sites plugin that previews ordinary websites.
- **Databases:** inspect and edit supported SQLite data through bounded tools.
- **Sharing:** grant paths, versions, or chat channels through the sync relay.

Document computation is not implicit. Formula-like text and fenced code remain
text unless an explicit plugin, script, database tool, or agent workflow runs
it.

## Collaboration

The opt-in sync relay transports engine operations, blobs, shares, and
presence. Better Auth provides identity through the workspace API. The relay
derives the actor from the authenticated session and enforces share boundaries.

## Invariants

- The renderer cannot provide trusted identity or authorization facts.
- Every engine request is scoped through a daemon workspace handle.
- A slow asynchronous response cannot repaint another workspace.
- Live document editing treats the Y.Doc session as canonical.
- Settlement writes the Markdown artifact through the engine.
- Plugin guests and HTML previews do not grant workspace authority by
  themselves.
