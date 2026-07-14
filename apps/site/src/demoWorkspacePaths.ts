export type DemoPathMove = {
  sourcePath: string;
  targetPath: string;
};

export function isPathAtOrBelow(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function rewritePathPrefix(
  path: string,
  fromPath: string,
  toPath: string,
): string {
  return isPathAtOrBelow(path, fromPath)
    ? `${toPath}${path.slice(fromPath.length)}`
    : path;
}

export function planDemoPathMove(
  paths: readonly string[],
  fromPath: string,
  toPath: string,
): DemoPathMove[] {
  const sourcePaths = paths.filter((path) => isPathAtOrBelow(path, fromPath));
  const sourceSet = new Set(sourcePaths);
  const existingPaths = new Set(paths);
  const moves = sourcePaths.map((sourcePath) => ({
    sourcePath,
    targetPath: rewritePathPrefix(sourcePath, fromPath, toPath),
  }));

  for (const { targetPath } of moves) {
    if (existingPaths.has(targetPath) && !sourceSet.has(targetPath)) {
      throw new Error(`A document already exists at ${targetPath}`);
    }
  }

  return moves;
}
