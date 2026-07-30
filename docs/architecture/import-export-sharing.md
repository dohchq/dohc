# Import, export, and sharing

## Import

Imports land in the folder the user selected. A name collision creates a safe
new name instead of overwriting an existing file. Drag-and-drop, folder menus,
and database import use the same path-containment rules.

## Export

- A document can export as Markdown, HTML, or PDF.
- A folder or workspace can export as a zip archive.
- Internal metadata, dependency folders, and secret-classified files do not
  enter archives.

## Sharing

The sync relay can share a path, version, or chat channel. The relay derives
the caller from the Better Auth session and filters every response
server-side.

A path or version share is read-only for the recipient. The recipient can open
it as a separate view or mount it under `shared-with-me/<label>/`. A mounted
share remains a projection of the owner’s filtered operation log.

A shared chat channel is bidirectional. The relay attributes every appended
message or reaction to the authenticated participant.

## Boundaries

- Secret-classified paths cannot be shared.
- A share cannot expose another path by traversal or a broad selector.
- A mounted share cannot be shared again.
- Host workspace capture, history, the engine index, and relay push exclude
  `shared-with-me/`. Search reads mounted shares through a separate read-only
  pass.
- Revocation stops updates without deleting the recipient’s existing
  projection.
- Copying shared files into an owned path is an explicit ownership change.
