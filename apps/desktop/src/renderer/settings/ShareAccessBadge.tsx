import type { ShareAccess } from "../../ipc/bridgeContract";

// The level a file share grants (#646), on every share row. Both lists show
// it always: a level shown only sometimes teaches the reader nothing when it
// is absent, so there is no "default" the reader has to infer.
//
// This is a mirror. The relay decides what the level grants; this only says
// which one the row carries.

const ACCESS_LABELS: Record<ShareAccess, string> = {
  view: "View",
  comment: "Comment",
  edit: "Edit",
};

export function ShareAccessBadge(props: { access: ShareAccess }) {
  return (
    <span
      data-testid="share-access-badge"
      data-access={props.access}
      className="shrink-0 rounded border border-line px-1 text-[10px] text-subtle"
    >
      {ACCESS_LABELS[props.access]}
    </span>
  );
}
