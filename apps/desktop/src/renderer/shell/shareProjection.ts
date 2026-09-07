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
