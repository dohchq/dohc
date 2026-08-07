import {
  realRelativeInRoot,
  resolvedAreaRefusal,
  type PathAccess,
  type RealTarget,
} from "@dohc/workspace-core/realPath";

// The desktop's guards read a path as SPELLED, then prove only that it stays
// INSIDE the workspace root. An in-workspace symlink answers that yes: a
// containment check stops an escape OUT of the root and says nothing about
// landing in a reserved area (#667). So every main-process site that decides
// authority or classification from a path asks THIS, on the path's real
// location, using the shared rule the MCP surface uses (#638).
//
// `label` names the operation in the user's nouns ("File path", "Move
// destination"), and `spelled` is the path as the caller named it, so a refusal
// carries both spellings: the one asked for and the one it leads to.
//
// Answers with the resolution it judged, root-relative and absolute. A caller
// that then acts on the path should use `resolvedAbsolute` rather than resolve
// again: two resolutions of one path can disagree, and the second one is the
// one no rule was applied to.
export async function assertResolvedWorkspacePath(input: {
  // The root the reservation is relative to. `.dohc` means the workspace's
  // own metadata dir, so a share mount passes ITS root, not the host's.
  rootPath: string;
  absolutePath: string;
  spelled: string;
  label: string;
  // "read" allows the shared-with-me projection (share mounts exist to be
  // read); "write" refuses it; "entry" is "write" plus "this renames the entry
  // itself rather than following it" — a delete, or a move's source.
  access: PathAccess;
}): Promise<{ relative: string; resolvedAbsolute: string }> {
  const target = await realRelativeInRoot(
    input.rootPath,
    input.absolutePath,
    input.access === "entry",
  );
  if (!target.ok) throw new Error(unresolvedRefusal(target, input.label, input.spelled));
  const refused = resolvedAreaRefusal(target.relative, input.access);
  if (refused) {
    throw new Error(
      `${input.label} leads to ${refused.article} ${refused.kind} area: ` +
        `${input.spelled} leads to ${target.relative}. ${refused.explain}`,
    );
  }
  return { relative: target.relative, resolvedAbsolute: target.resolvedAbsolute };
}

// A path the resolver could not place. Each cause gets its own next step: a
// missing target can be created, a cycle cannot, a filesystem error is about
// the path's permissions rather than its spelling, and an unreadable workspace
// folder is not about this path at all.
function unresolvedRefusal(
  target: Extract<RealTarget, { ok: false }>,
  label: string,
  spelled: string,
): string {
  switch (target.reason) {
    case "escapes-workspace":
      return `${label} escapes the workspace: ${spelled}.`;
    case "unreadable-root":
      return (
        `dohc could not read the workspace folder (${target.code}). ` +
        `The workspace folder failed, not ${spelled}. ` +
        `Check that the workspace folder is present and readable.`
      );
    case "dangling-symlink":
      return (
        `${label} has a symlink with no target: ${spelled}. ` +
        `dohc cannot tell where the path leads. Create the target first, or use ` +
        `a path with no symlink.`
      );
    case "unresolvable-symlink":
      return (
        `${label} has a symlink dohc cannot resolve (${target.code}): ${spelled}. ` +
        `dohc cannot tell where the path leads. Use a path with no symlink.`
      );
    case "unreadable-path":
      return (
        `dohc could not check where ${spelled} leads (${target.code}). ` +
        `Fix the error on this path, or use another path.`
      );
  }
}
