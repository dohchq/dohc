export interface NamedAppTarget {workspaceId: string; publicationId: string}

/** Parses `/s/apps/:workspaceId/:publicationId`. Both ids are already URL-safe, so no decoding is applied. */
export function namedAppTarget(pathname: string): NamedAppTarget | null {
  const match = /^\/s\/apps\/([A-Za-z0-9_-]{1,128})\/([a-f0-9]{64})\/?$/.exec(pathname);
  return match ? {workspaceId: match[1]!, publicationId: match[2]!} : null;
}
