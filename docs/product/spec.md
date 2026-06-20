---
id: product-spec
title: dohc Product Spec
---

# dohc — product spec (overview)

A working summary of what dohc does today. The desktop implementation
lives in `apps/desktop`; the Cloud web client lives in `apps/web`.

## Core model

- **Atoms** — plain-text markdown files in a per-user vault. Each has a
  rename-proof `id:` (frontmatter), a `title:`, and optional user
  properties. Wikilinks (`[[path]]`) connect atoms.
- **Inline atoms** — `{key: value}` captures inside prose, and `{= … }`
  formulas that compute live from other files (e.g.
  `{= sum(logs.2025_07_*.billable)}`). Computed values render after the
  token and update as the underlying files change.
- **Live queries** — block-level live lists/tables backed by inspectable
  fenced `query` source. They are for repeating collections; inline atoms
  and formulas remain the live scalar/value syntax.
- **Sites** — normal browser-viewable website folders anywhere in the
  workspace. dohc detects `index.html`, web package scripts/dependencies,
  common framework config, build outputs, and optional `dohc.json` metadata.
  Agents can create ordinary React/Vite/Next/static sites without knowing
  dohc-specific structure.
- **Collections** — readable structured data backed by markdown tables,
  markdown cards, CSV, JSONL, YAML, or SQLite-backed database tables.
- **SQLite database files** — first-class workspace files stored outside
  markdown atoms. Raw SQLite bytes are never CRDT-synced.
- **Entities** — a flexible store (people, projects, clients, …) with
  user-declared types, shown through live queries and sites.
- **Folders** — organize atoms; support icons, colors, stars, and
  drag-and-drop move with wikilink-rewrite cascade.

## Surfaces

- **Workspace shell** — activity bar, file tree, document canvas, and an
  inspector/chat column (exactly one of chat / imports+exports open).
- **Editor** — Tiptap/Yjs-backed markdown editor with a raw source mode,
  wikilink pills, inline-atom decorations, and ASCII sketches.
- **HTML atoms** — `.html` atoms render in a sandboxed, server-built
  shell (zero-network, sanitized).
- **Sites** — normal websites previewed inside dohc. Static sites are served
  from the workspace folder; package sites can run a dev script; built sites
  can run build and serve `dist`, `build`, or `out`. Optional dohc SDK
  integration can enhance a site, starting with local file reads through the
  preview bridge, but websites remain ordinary websites.
- **Chat** — the dohc agent: find, draft, organize; shows sources and
  changes.
- **Onboarding** — a short questionnaire seeds the agent's first turn,
  which builds source atoms, identity context, a setup run, and a first
  cockpit (`home.html` or a normal site folder for interactive workflows).
  Generated sites should pass the desktop Sites preview E2E path before
  onboarding can finish.
- **Graph** — a force-directed view of atoms and their links.
- **Imports / Exports** — controlled workspace-to-workspace data/text
  exchange. Exports publish only selected fields; imports subscribe to
  fields another workspace exposes.
- **Document sharing** — per-atom shares (view/edit), separate from
  imports/exports.

## Stack

TanStack Start + TanStack Router, React 19, Vite, Tailwind CSS v4,
Convex (backend + agent), WorkOS AuthKit, Tiptap, Yjs, Hocuspocus, Vitest,
Nitro.

## Invariants

- The agent always checks onboarding state first and never ends
  onboarding with an empty vault.
- Authorization is derived server-side; no client may fake completion or
  ownership. See `docs/security/authz-boundaries.md`.
