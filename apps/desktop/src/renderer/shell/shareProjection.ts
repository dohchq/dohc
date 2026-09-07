// What a removed mount does to path-keyed UI state.
//
// A folder that went takes its tabs, pins and drafts with it — the same
// reprojection an Explorer folder delete makes. A folder that stayed must
// take nothing: record cleanup left the files exactly where they were, and
// projecting a delete over them would discard state for files the user still
// has open.
export function shareUnmountProjection(input: {
  shareId: string;
  label: string;
  folderLeft: boolean;
}): Array<{ id: string; kind: "delete-folder"; path: string }> {
  if (input.folderLeft) return [];
  return [
    {
      id: `unmount-${input.shareId}`,
      kind: "delete-folder",
      path: `shared-with-me/${input.label}`,
    },
  ];
}

// Which vanished mounts reproject, given the ones whose FOLDER stayed.
//
// Both removal surfaces land here: the Explorer's own unmount records the
// share id before it reloads, and the Settings list reports its id through
// the files-changed callback. Either way the rule is the same one, and a
// share whose folder stayed projects nothing. Consuming the id keeps a later
// unrelated reload from reading a stale exemption.
export function goneMountProjections(input: {
  previous: ReadonlyArray<{ shareId: string; label: string }>;
  next: ReadonlyArray<{ shareId: string }>;
  foldersLeftBehind: Set<string>;
}): Array<{ id: string; kind: "delete-folder"; path: string }> {
  return input.previous
    .filter(
      (mount) => !input.next.some((candidate) => candidate.shareId === mount.shareId),
    )
    .flatMap((mount) =>
      shareUnmountProjection({
        shareId: mount.shareId,
        label: mount.label,
        folderLeft: input.foldersLeftBehind.delete(mount.shareId),
      }),
    );
}

// The one closing line a manual "Refresh shares" leaves behind.
//
// One line, because a second call replaces the first: damage reported before
// the summary was overwritten by it, and the user saw only "Shares
// refreshed", which is exactly the wrong half. Damage is carried INTO the
// summary, and the instruction that fixes it survives.
export function shareRefreshSummary(
  results: ReadonlyArray<{
    label: string;
    status: "updated" | "unchanged" | "ended" | "damaged";
    changedPaths: number;
  }>,
): string {
  if (results.length === 0) return "No shares are added to this workspace.";
  const changed = results.reduce((sum, row) => sum + row.changedPaths, 0);
  const ended = results.filter((row) => row.status === "ended");
  const damaged = results.filter((row) => row.status === "damaged");
  const refreshed = `Shares refreshed — ${changed} ${
    changed === 1 ? "file" : "files"
  } updated${
    ended.length > 0 ? `; ${ended.map((row) => row.label).join(", ")} ended` : ""
  }.`;
  if (damaged.length === 0) return refreshed;
  return `${refreshed} dohc can't read what ${damaged
    .map((row) => row.label)
    .join(", ")} ${damaged.length === 1 ? "grants" : "grant"}. Remove ${
    damaged.length === 1 ? "it" : "them"
  } and add ${damaged.length === 1 ? "the share" : "those shares"} again.`;
}
