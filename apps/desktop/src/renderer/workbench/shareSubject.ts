import type { AccessShareRow } from "@dohc/workspace-contracts/access";
import { shareSubjectFallback } from "@dohc/security-contract/share-labels";
import { basenameOf } from "../path";

export type ShareSubjectKind = "missing" | "damaged" | "chat" | "version" | "path";

// What a share covers, in words: its name, the folder it sits in, and the
// whole of it for a title. The Sharing view draws it; Settings search finds it.
export function shareSubject(row: AccessShareRow): {
  kind: ShareSubjectKind; name: string; folder: string | null; title: string; path: string | null;
} {
  const selector = row.selector;
  // Ended and removed grants come without what they covered; only a damaged
  // one is a fault.
  if (!selector) {
    const damaged = row.status === "damaged";
    const name = row.subjectName ?? (damaged ? "Unreadable share" : "Ended share");
    return { kind: damaged ? "damaged" : "missing", name, folder: null, title: name, path: null };
  }
  if (selector.kind === "chat" || selector.kind === "group") {
    const name = row.subjectName ?? shareSubjectFallback(selector);
    return { kind: "chat", name, folder: null, title: name, path: null };
  }
  const [first, ...rest] = selector.paths;
  if (first === undefined) {
    const version = selector.versionId === null || selector.versionId === "main" ? "Main" : selector.versionId;
    const name = row.subjectName ?? `Version ${version}`;
    return { kind: "version", name, folder: null, title: name, path: null };
  }
  const slash = first.lastIndexOf("/");
  return {
    kind: "path",
    name: rest.length > 0 ? `${basenameOf(first)} +${rest.length}` : basenameOf(first),
    folder: slash > 0 ? `${first.slice(0, slash)}/` : null,
    title: selector.paths.join(", "),
    path: first,
  };
}
