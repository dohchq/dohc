// Where a path REALLY lands inside a workspace root, and which reservation
// refuses that location. Both answers come from here and nowhere else: every
// surface that decides authority from a path (MCP tools, the desktop main
// process) asks the same two questions of the same code, so no surface can
// hold a stale copy of the rule.
//
// This is the only module in workspace-core that touches node:fs, so it is a
// subpath export ("@dohc/workspace-core/realPath") and stays out of the barrel
// the renderer bundles.
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, sep } from "node:path";
import { hasIgnoredSegment, isDohcMetadataPath, isSharedWithMePath } from "./paths";

// What a caller does with the path, in the same read/write split the lexical
// validators use. "entry" is "write" for every rule, and additionally says the
// caller renames the entry itself rather than following it.
export type PathAccess = "read" | "write" | "entry";

// WHERE does `absolute` really land inside `root`, after symlinks? Lexical
// containment (the path validators) stops ../ and friends, but a symlink that
// already exists inside the workspace can point anywhere; every later fs call
// would follow it. We realpath the deepest EXISTING ancestor (the file itself
// for reads, its parent chain for not-yet-created targets) and require it to
// stay under the canonical root. The root itself may legitimately be a symlink,
// so we compare against realpath(root).
//
// Returns the real path RELATIVE to the canonical root, with the still-absent
// tail appended — the answer callers need to judge where the operation lands,
// not just whether it is inside. Every failure refuses.
export type RealTarget =
  | { ok: true; relative: string }
  | { ok: false; reason: "escapes-workspace" }
  | { ok: false; reason: "unreadable-root"; code: string }
  | { ok: false; reason: "dangling-symlink" }
  | { ok: false; reason: "unresolvable-symlink"; code: string }
  | { ok: false; reason: "unreadable-path"; code: string };

// The only two errnos that mean NOTHING is at a path. Every other one leaves
// the question unanswered, and an unanswered question is not a "no".
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"]);
const UNNAMED_ERROR = "unknown error";

function errnoCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : null;
}

// `noFollow` says the caller mutates the ENTRY at `absolute` rather than
// reading or writing through it -- delete and a move's source, both of which
// rename the entry itself. Its final name is then held back and only the
// PARENT chain is resolved, because where that entry POINTS is not the
// question: a link there is the thing being removed, whether it is live,
// broken, or looping. The parent must still resolve inside the root, and the
// caller still decides the reserved rule on the parent's real path plus this
// name, so an alias INSIDE a reserved area still refuses.
export async function realRelativeInRoot(
  root: string,
  absolute: string,
  noFollow = false,
): Promise<RealTarget> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    return { ok: false, reason: "unreadable-root", code: errnoCode(error) ?? UNNAMED_ERROR };
  }
  // A filesystem root realpaths WITH its separator (`C:\`, `/`); nothing else
  // does. Drop it so one prefix test and one slice serve both.
  if (realRoot.endsWith(sep)) realRoot = realRoot.slice(0, -1);
  const absentTail: string[] = [];
  let probe = absolute;
  if (noFollow) {
    // Never empty, never "." or ".." -- validateUserMaterializePath drops both,
    // so this is always a real component below the root.
    absentTail.push(basename(absolute));
    probe = dirname(absolute);
  }
  for (;;) {
    let real: string;
    try {
      real = await realpath(probe);
    } catch (error) {
      // A component realpath cannot resolve is only safe to call "not there
      // yet" when NOTHING is there. A dangling symlink is present, and
      // whatever creates its target later decides where this path lands.
      // lstat separates absent from present; realpath cannot.
      //
      // A permission or I/O error answers neither question. Climbing past it
      // would append the component as spelling, and spelling is exactly what
      // the reserved rule must not decide on (#638) — so it refuses instead.
      const realpathCode = errnoCode(error) ?? UNNAMED_ERROR;
      const climbable = ABSENT_CODES.has(realpathCode) || realpathCode === "ELOOP";
      if (!climbable) return { ok: false, reason: "unreadable-path", code: realpathCode };
      try {
        await lstat(probe);
        // The link is there and realpath will not follow it. ENOENT proves the
        // target is missing; ELOOP proves a cycle. Only the first is dangling.
        // A no-follow caller never reaches here for its own entry -- that name
        // was held back above -- so this is always a link PARTWAY along the
        // path, and where it leads is a question that still has to be answered.
        return ABSENT_CODES.has(realpathCode)
          ? { ok: false, reason: "dangling-symlink" }
          : { ok: false, reason: "unresolvable-symlink", code: realpathCode };
      } catch (cause) {
        const code = errnoCode(cause) ?? UNNAMED_ERROR;
        if (!ABSENT_CODES.has(code)) {
          return { ok: false, reason: "unreadable-path", code };
        }
      }
      const parent = dirname(probe);
      if (parent === probe) return { ok: false, reason: "escapes-workspace" };
      absentTail.unshift(basename(probe));
      probe = parent;
      continue;
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      return { ok: false, reason: "escapes-workspace" };
    }
    const resolved = real === realRoot ? "" : real.slice(realRoot.length + 1);
    return {
      ok: true,
      relative: [...resolved.split(sep), ...absentTail].filter(Boolean).join("/"),
    };
  }
}

// WHICH rule refuses this resolved path, or null when none does. It names the
// matched rule rather than answering yes/no, because a refusal has to state the
// constraint it actually hit: an alias landing in `.git` is not refused by the
// `.dohc` reservation, and saying so would send a reader to the wrong rule.
// Same predicates the lexical validators use, in the same read/write split.
// `.dohc` is checked before the ignored segments it also belongs to, so the
// more specific rule wins.
export function resolvedAreaRefusal(
  realRelative: string,
  access: PathAccess,
): { kind: "reserved" | "ignored"; article: "a" | "an"; explain: string } | null {
  if (isDohcMetadataPath(realRelative)) {
    return {
      kind: "reserved",
      article: "a",
      explain: "dohc reserves .dohc for workspace state. Use a path in your own files.",
    };
  }
  if (access !== "read" && isSharedWithMePath(realRelative)) {
    return {
      kind: "reserved",
      article: "a",
      explain:
        "dohc reserves shared-with-me for share mounts. Copy the file into your own files first.",
    };
  }
  const ignored = realRelative.split("/").find((segment) => hasIgnoredSegment(segment));
  if (ignored) {
    return {
      kind: "ignored",
      article: "an",
      explain: `dohc does not manage ${ignored}. Use a path in your own files.`,
    };
  }
  return null;
}
