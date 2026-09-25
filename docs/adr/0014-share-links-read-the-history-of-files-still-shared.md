# A share link reads the history of files still in the share

Status: accepted September 25, 2026.

A share link could read only the files in the share now. The link log already listed every change and named the content of each revision, but the relay refused any hash that was not current. A link holder, or their agent, could see that `proposal.md` changed but could not read the version before the change. Named recipients could read superseded revisions, and even deleted files, through the rule in `historicalSharedBlob`.

We decided that a share link reads earlier revisions of files that are still in the share, within retention. Deleting a file or moving it out of the share withdraws that file and its whole history from the link at once. An overwrite does not withdraw anything, so text removed by an edit stays readable in the earlier revision until retention ends. Retention is the relay's log since the workspace's current replication epoch. A restore or reset that starts a new epoch raises the epoch floor, and every link loses the revisions below it.

## The rule

The relay serves a blob to a link when the blob is a current file of the share, as before. Otherwise it serves the blob only when all of these hold at the time of the read:

- A log row above the workspace's epoch floor names the blob as the content after a write or rename, or as a fork-snapshot file of a pinned version.
- The link's share filter admits that row, with the grant's effective selector and version. A snapshot file must sit at a selected path.
- The row's object is the current file at a selected path now: the object's latest moment in the version set that path's current file, above the epoch floor.
- The object has stayed in the share since that row: no later moment of the object deleted it or put it outside the selector.

The relay re-checks the capability, its generation, and revocation on every read, as it does for current files. A hash from the log grants nothing by itself.

## Considered options

- Keep links on current files only. Link holders and their agents then cannot see how the work changed, which the browser log already shows them in outline.
- Serve every blob a retained, admitted log row names, as for named recipients. Then deleting a file or moving it out of the share no longer withdraws it from a link. A link can reach people the owner never chose, so the owner needs a withdrawal that works at once.

## Consequences

- To remove text from a link's reach, the owner deletes the file or moves it out of the share. Editing the text out leaves it in an earlier revision until retention ends. Rotating the link or revoking it withdraws everything.
- A file moved out of the share and back in serves only revisions from after it came back. The move out withdrew the earlier revisions, and moving the file back does not restore them.
- Content a file had before it moved into the share stays unreadable. The row that moved it in names a path outside the share, so the filter refuses it.
- A revision whose moment the relay could not apply to current state is refused, because its object is not the current file at its path.
- One read examines at most 1,024 moments with the requested content and at most 1,024 later moments of the file. A revision the relay cannot reach within those bounds is refused, so a link's work does not grow with how often content recurs or how often a file is edited.
