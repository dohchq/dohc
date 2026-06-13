# E4c Codex Review

Commit reviewed: `4627209 e4c: switch desktop collab to rich markdown docs`

Invocation note: the normal Windows-side Codex config contains
`service_tier = "priority"`, which Codex CLI `0.130.0` rejects. The review was
run from a temporary `CODEX_HOME` with the same auth file and
`service_tier = "fast"`.

## Findings

- **P1: Reconcile non-empty synced docs before writing.** On first sync, the
  desktop hook skipped reconcile when the server already had a non-empty rich
  CRDT. If the local disk file had diverged before opening collab, the settle
  writer could overwrite that local edit instead of preserving it through the
  existing `.conflict` rescue path.
- **P2: Keep non-markdown atoms plain-text.** The Postgres ACL decided rich vs
  plain bootstrap from path alone. A forged collab token request for a
  non-markdown atom (`text`, `csv`, `json`, `html`) could parse/project that
  body as markdown and rewrite or drop content.

## Disposition

Both findings are fixed in `e4c(fix)`.

- The workspace-api collab token route now mints tokens only for markdown atoms
  and returns the current atom body as `baseMarkdown`.
- Main validates/passes `baseMarkdown` to the renderer.
- `useCollabDoc` seeds `baseMarkdown` as the first-sync materialization base
  only when the local file still equals that body cache; divergent local disk
  text keeps `null` base and goes through the conflict-rescue path.
- Postgres ACL now selects atom `kind` and treats every non-markdown atom as
  plain-text-canonical, with app/source path handling retained.
- Regression coverage was added in `collabSession.test.ts`,
  `services/workspace-api/src/routes/collab.test.ts`, and
  `services/hocuspocus/src/postgres-acl.test.ts`.
