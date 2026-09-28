import { asRecord } from "@dohc/workspace-core/records";

export function shareLinkSummary(
  metadata: { access?: unknown; effectiveSelector?: unknown },
  liveEditingAvailable = true,
) {
  const selector = asRecord(metadata.effectiveSelector);
  const access = metadata.access;
  const permissions = access === "view"
    ? "You can read files and comments. This link does not let you comment or edit."
    : access === "comment"
      ? "You can read files and post comments. This link does not let you edit files."
      : access === "edit"
        ? "This link grants read, comment, and edit access. " +
          (selector?.versionId !== null
            ? "Editing is unavailable on this link."
            : (liveEditingAvailable
              ? "You can edit Markdown files here. Editing pauses while the workspace is offline, and you can still read then. "
              : "") +
              "You can change a Collection's collection.yaml and automations.yaml here. " +
              "The owner's computer applies each change the next time it syncs.")
        : "The link's permissions are unavailable.";
  const paths = selector?.paths;
  const scope = Array.isArray(paths) && paths.every(path => typeof path === "string")
    ? paths.length > 0
      ? `Included paths: ${paths.join(", ")}. This link also includes this share's comments.`
      : "Included: shareable workspace files and this share's comments."
    : "The included paths are unavailable.";
  const version = selector?.versionId === null
    ? "This link follows the current version."
    : typeof selector?.versionId === "string"
      ? "This link is limited to a pinned version."
      : "The included version is unavailable.";
  return {
    permissions,
    included: `${scope} ${version}`,
    history: "You can read retained history of files that remain in this share. " +
      "Deleted files and files moved out lose their readable history.",
  };
}
