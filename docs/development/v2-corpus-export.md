# v2 Corpus Export

## Purpose

Phase 0 exports the current user's atoms before v2 writes exist. The export is used for markdown-to-Y.Doc round-trip tests and as a rollback backup.

## Output Layout

Private exports live under `tests/fixtures/user-corpus-backup/` and should not include secrets in committed fixtures.

Each exported atom should have:

- `atomId`
- `path`
- `title`
- `bodyHash`
- `bodyLength`
- `updatedAt`
- `markdownFile`

## Manifest Shape

```json
{
  "exportedAt": "2026-05-25T00:00:00.000Z",
  "workspaceId": "user_...",
  "atoms": [
    {
      "atomId": "atom_...",
      "path": "Notes/Example.md",
      "title": "Example",
      "bodyHash": "sha256:...",
      "bodyLength": 1234,
      "updatedAt": 0,
      "markdownFile": "atoms/atom_....md"
    }
  ]
}
```

## Export Procedure

1. Add a Convex internal action or one-off local script that reads the current workspace's atoms.
2. Write each body to `tests/fixtures/user-corpus-backup/atoms/<atomId>.md`.
3. Write `tests/fixtures/user-corpus-backup/manifest.json`.
4. Run Phase 1.2 round-trip tests against this directory.
5. Commit only sanitized fixtures unless Ice explicitly approves committing real notes.

## Privacy Rule

Commit only synthetic fixtures unless Ice explicitly chooses to commit real notes.

`tests/fixtures/user-corpus-backup/.gitignore` ignores real exports by default. Keep private atom bodies local unless a sanitized corpus is intentionally promoted into committed fixtures.
