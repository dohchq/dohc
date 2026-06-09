# Local Files And Cloud Sandbox

dohc treats text as the primitive, but the workspace source of truth is still
dohc policy. Filesystem views and shell sessions are projections of that source
of truth, not a bypass around it.

## Source Of Truth

The canonical workspace lives in dohc:

- atoms and folders are scoped to a workspace.
- assets and database files are first-class workspace files.
- Y.Doc remains canonical for collaborative documents.
- `atoms.body` is a derived markdown/text cache, not the only source of truth.
- permissions, locks, app trust, sharing, and review gates are enforced before
  writes are accepted.

## Filesystem Projection

The filesystem projection materializes workspace files into a normal directory
shape so agents can use familiar tools such as `cat`, `rg`, editors, and shell
commands.

Projection metadata lives under:

```text
.dohc/manifest.json
```

The manifest records workspace identity, backend mode, projected file metadata,
revision tokens, and ignored internal files. Agents can inspect the projection,
but writes are captured as diffs and applied back through dohc policy.

## Local Sync

Local sync lets a user work with a real folder while dohc preserves provenance.
The sync loop:

1. reads the workspace through the backend contract.
2. materializes files to disk.
3. scans local changes.
4. converts changes into create, update, delete, or rename operations.
5. applies those operations through backend authorization and conflict checks.

Local files are a working surface. The backend remains responsible for
durability and access control.

## Cloud Sandbox

The cloud sandbox gives agents a bash-like workspace without trusting shell
writes blindly. A session mounts a workspace projection, allows only configured
commands, captures diffs, and applies those diffs through dohc policy.

Shell writes must flow through policy because:

- user locks and folder/atom access still matter.
- app trust and review gates still matter.
- sharing boundaries must not leak private files.
- provenance should show what changed and why.
- generated assets and SQLite bytes are not markdown patches.

The current sandbox is a first service shape. Production exposure still needs
container or equivalent isolation before arbitrary commands are allowed.
