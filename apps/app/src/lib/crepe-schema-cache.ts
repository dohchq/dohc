// M1 step 3 sub-commit 3.2 (multiplayer-and-h-followups §8 +
// Codex v3 critical #3) — global cache of the Crepe ProseMirror
// schema, captured post-mount via Milkdown's `schemaCtx` slice.
//
// Why this exists:
//   - useCollabSync's bootstrap path needs the schema to deserialize
//     a server snapshot into a PM Node (via schema.nodeFromJSON).
//   - Crepe builds the schema dynamically during construction; the
//     only way to extract it is editor.action((ctx) =>
//     ctx.get(schemaCtx)) AFTER the editor mounts.
//   - The first mounted Crepe populates the cache; subsequent
//     mounts read it synchronously.
//   - Schema is INVARIANT across mounts (Crepe's feature set is
//     the same every time), so caching once is safe.
//
// Codex v3 review confirmed:
//   - schemaCtx IS exported from @milkdown/kit/core (NOT from the
//     deep `@milkdown/core/internal-plugin/schema` path I had in
//     the v3 doc — that path is not in the package's exports map).
//   - This cache pattern has a bootstrap-ordering subtlety: the
//     first multiplayer mount can't read the schema BEFORE its own
//     editor mounts. Mitigation: subscribers + an effect that re-
//     runs when the schema arrives. Live editors mount from
//     defaultValue (markdown) as today; collab plugins attach
//     after, and the rebase loop converges to server state.

import type { Editor } from '@milkdown/kit/core'
import { schemaCtx } from '@milkdown/kit/core'
import type { Schema } from '@milkdown/kit/prose/model'

let _cached: Schema | null = null
const _subscribers = new Set<(s: Schema) => void>()

/** Capture the schema from a freshly-mounted Crepe editor. Called
 *  inside the useEditor closure after Crepe finishes booting (the
 *  editor instance is available from the useEditor() result). No-op
 *  if already cached.
 *
 *  Idempotent — safe to call from every mount. Schema is invariant
 *  across Crepe instances built with the same feature set, so
 *  re-capturing returns the same Schema object. */
export function captureSchemaFromEditor(editor: Editor): void {
  if (_cached) return
  // editor.action runs synchronously and gives us the live ctx.
  editor.action((ctx) => {
    const schema = ctx.get(schemaCtx)
    if (!schema) return // shouldn't happen; defensive
    _cached = schema
    // Drain subscribers waiting for the schema.
    for (const fn of _subscribers) {
      try {
        fn(schema)
      } catch {
        // A subscriber throwing must not prevent other subscribers
        // from receiving the schema. Best-effort fan-out.
      }
    }
    _subscribers.clear()
  })
}

/** Synchronous read. Returns null if no editor has mounted yet. */
export function getCachedSchema(): Schema | null {
  return _cached
}

/** Subscribe to schema arrival. Fires synchronously if the cache
 *  is already populated; otherwise stores the callback and fires
 *  it when captureSchemaFromEditor lands.
 *
 *  Returns an unsubscribe function. */
export function subscribeSchema(fn: (s: Schema) => void): () => void {
  if (_cached) {
    fn(_cached)
    return () => {}
  }
  _subscribers.add(fn)
  return () => {
    _subscribers.delete(fn)
  }
}

/** Test-only: clear the cache + subscribers. */
export function _resetSchemaCacheForTests(): void {
  _cached = null
  _subscribers.clear()
}
