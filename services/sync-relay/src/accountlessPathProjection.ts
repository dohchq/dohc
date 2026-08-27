import type { ShareSelector } from "./shareFilter";

const PATH_FIELDS = new Set([
  "path",
  "payloadBeforePath",
  "payloadAfterPath",
  "beforePath",
  "linkedPath",
]);

interface ProjectionRoot {
  realPath: string;
  visiblePath: string;
}

export interface AccountlessPathProjection {
  selector: ShareSelector;
  projectPath(path: string): string | null;
  projectPayload(payload: unknown): unknown | null;
}

function pathName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function projectionRoots(paths: readonly string[]): ProjectionRoot[] {
  const realPaths = [...new Set(paths)].sort();
  const reservedNames = new Set(realPaths.map(pathName));
  const usedNames = new Set<string>();

  return realPaths.map((realPath) => {
    const name = pathName(realPath);
    let visiblePath = name;
    if (usedNames.has(visiblePath)) {
      let discriminator = 2;
      do {
        visiblePath = `${discriminator}~${name}`;
        discriminator += 1;
      } while (reservedNames.has(visiblePath) || usedNames.has(visiblePath));
    }
    usedNames.add(visiblePath);
    return { realPath, visiblePath };
  });
}

function projectNestedPaths(
  value: unknown,
  projectPath: (path: string) => string | null,
): unknown | null {
  if (Array.isArray(value)) {
    const projected: unknown[] = [];
    for (const entry of value) {
      const projectedEntry = projectNestedPaths(entry, projectPath);
      if (projectedEntry === null && entry !== null) return null;
      projected.push(projectedEntry);
    }
    return projected;
  }
  if (value === null || typeof value !== "object") return value;

  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (PATH_FIELDS.has(key) && typeof entry === "string") {
      const projectedPath = projectPath(entry);
      if (projectedPath === null) return null;
      projected[key] = projectedPath;
      continue;
    }
    const projectedEntry = projectNestedPaths(entry, projectPath);
    if (projectedEntry === null && entry !== null) return null;
    projected[key] = projectedEntry;
  }
  return projected;
}

export function createAccountlessPathProjection(
  selector: ShareSelector,
): AccountlessPathProjection {
  const roots = projectionRoots(selector.paths);
  const projectPath = (path: string): string | null => {
    if (roots.length === 0) return path;
    let matched: ProjectionRoot | null = null;
    for (const root of roots) {
      if (path !== root.realPath && !path.startsWith(`${root.realPath}/`)) continue;
      if (matched === null || root.realPath.length > matched.realPath.length) {
        matched = root;
      }
    }
    if (matched === null) return null;
    return `${matched.visiblePath}${path.slice(matched.realPath.length)}`;
  };

  return {
    selector: {
      ...selector,
      paths: roots.map((root) => root.visiblePath),
    },
    projectPath,
    projectPayload: (payload) => projectNestedPaths(payload, projectPath),
  };
}
