import type { HeadingNavigationTarget as HeadingTarget } from "./editor/OutlinePanel";
import type { WikilinkFile } from "./editor/wikilinkPlugin";
import type { WorkspaceLinkTarget } from "./linkActivation";

type WikilinkNavigation = {
  path: string;
  headingTarget?: HeadingTarget;
};

const MARKDOWN_EXTENSION_PATTERN = /\.(?:md|markdown)$/iu;

function normalizeMarkdownExtension(path: string): string {
  return path.replace(MARKDOWN_EXTENSION_PATTERN, (extension) =>
    extension.toLowerCase(),
  );
}

function normalizeWikilinkPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/gu, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function wikilinkPathCandidates(target: string, currentPath: string): string[] {
  const slashed = target.replace(/\\/gu, "/");
  const currentDirectory = currentPath.includes("/")
    ? currentPath.slice(0, currentPath.lastIndexOf("/"))
    : "";
  const direct = normalizeWikilinkPath(slashed);
  const relative = normalizeWikilinkPath(
    currentDirectory ? `${currentDirectory}/${slashed}` : slashed,
  );
  const explicitlyRelative = slashed.startsWith("./") || slashed.startsWith("../");
  return [...new Set(explicitlyRelative ? [relative, direct] : [direct, relative])];
}

function findKnownWikilinkFile(
  target: string,
  currentPath: string,
  knownFiles: ReadonlyArray<WikilinkFile>,
): WikilinkFile | undefined {
  const candidates = wikilinkPathCandidates(target, currentPath);
  for (const candidate of candidates) {
    const hasMarkdownExtension = MARKDOWN_EXTENSION_PATTERN.test(candidate);
    const candidateWithNormalizedExtension =
      normalizeMarkdownExtension(candidate);
    const match = knownFiles.find((file) => {
      const knownPath = normalizeWikilinkPath(file.path);
      const knownWithNormalizedExtension =
        normalizeMarkdownExtension(knownPath);
      const knownWithoutExtension = knownPath.replace(
        MARKDOWN_EXTENSION_PATTERN,
        "",
      );
      return (
        candidateWithNormalizedExtension === knownWithNormalizedExtension ||
        (!hasMarkdownExtension && candidate === knownWithoutExtension)
      );
    });
    if (match) return match;
  }
  return undefined;
}

function withMarkdownExtension(path: string): string {
  return MARKDOWN_EXTENSION_PATTERN.test(path) ? path : `${path}.md`;
}

/** Resolve a rich-editor wikilink. A complete known-file path is authoritative
 * even when it contains `#`; only unmatched suffixes become heading fragments.
 * Fragment-only links stay in the current file, and unknown links retain the
 * existing `.md` fallback after path normalization. */
export function resolveWikilinkNavigation(
  target: string,
  currentPath: string,
  knownFiles: ReadonlyArray<WikilinkFile>,
  nonce: number,
): WikilinkNavigation {
  // A leading hash is the explicit same-file heading form. A file whose name
  // begins with `#` remains addressable through a path such as `./#notes`.
  if (target.startsWith("#")) {
    const fragment = target.slice(1);
    return {
      path: currentPath,
      ...(fragment
        ? { headingTarget: { anchor: fragment, nonce } }
        : {}),
    };
  }

  const fullTargetMatch = findKnownWikilinkFile(target, currentPath, knownFiles);
  if (fullTargetMatch) return { path: fullTargetMatch.path };

  // Prefer the longest known filename before a `#`. This keeps an explicit
  // heading navigable for files that themselves contain one or more hashes,
  // e.g. `notes/release#1.md#decisions`.
  for (let hashIndex = target.lastIndexOf("#"); hashIndex > 0;) {
    const fileTarget = target.slice(0, hashIndex);
    const fragment = target.slice(hashIndex + 1);
    const match = findKnownWikilinkFile(fileTarget, currentPath, knownFiles);
    if (match) {
      return {
        path: match.path,
        ...(fragment
          ? { headingTarget: { anchor: fragment, nonce } }
          : {}),
      };
    }
    hashIndex = target.lastIndexOf("#", hashIndex - 1);
  }

  const hashIndex = target.indexOf("#");
  const fileTarget = hashIndex === -1 ? target : target.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : target.slice(hashIndex + 1);
  let path = currentPath;
  if (fileTarget) {
    const match = findKnownWikilinkFile(fileTarget, currentPath, knownFiles);
    const fallback = wikilinkPathCandidates(fileTarget, currentPath)[0] ?? fileTarget;
    path = match?.path ?? withMarkdownExtension(fallback);
  }
  return {
    path,
    ...(fragment
      ? { headingTarget: { anchor: fragment, nonce } }
      : {}),
  };
}

export function resolveWorkspaceLinkNavigation(
  target: WorkspaceLinkTarget,
  currentPath: string,
  knownFiles: ReadonlyArray<WikilinkFile>,
  nonce: number,
): WikilinkNavigation {
  let path = currentPath;
  if (target.path) {
    const resolutionBase = target.path.startsWith("/") ? "" : currentPath;
    const match = findKnownWikilinkFile(target.path, resolutionBase, knownFiles);
    const fallback =
      wikilinkPathCandidates(target.path, resolutionBase)[0] ?? target.path;
    path = match?.path ?? withMarkdownExtension(fallback);
  }

  return {
    path,
    ...(target.rawFragment !== undefined
      ? { headingTarget: { anchor: target.rawFragment, nonce } }
      : {}),
  };
}
