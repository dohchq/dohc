# Record properties ride the document's frontmatter map

A collection record needs per-field concurrent editing, attribution, and sync. The desktop already holds a document's frontmatter as a Y.Map named `frontmatter` inside the live document and projects it to YAML on settlement, so record properties ride that map instead of a new `record.field.set` replication op. Per-field last-writer-wins, replication, share filtering, and the replay-parity gates all come from the existing `ydoc.update` path; the engine's new work is schema validation, an index over frontmatter in engine.db, and per-field history and events derived by diffing the map at apply time.

## Considered options

A typed `record.field.set` op kind was rejected. It pays the full new-op-kind cost across contracts, the Rust apply path, the relay share filter, and the parity gates, and it creates a second writer for the same YAML block the frontmatter map already owns. Two mechanisms that can disagree about one record is the failure we refused.

## Consequences

- Every record mints a Y.Doc lineage at creation. Only body content stays lazy.
- Per-field history is derived, not carried on ops. The engine diffs the map at apply time, and that diff is the only source of field-level attribution and events.
- Collection data gets the relay treatment documents get today: plaintext payloads the relay treats as opaque by convention. Data that needs secrecy belongs in the secret lane, not in a collection.
