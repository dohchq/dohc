import { bridge } from "./bridge";
import type { HeadingNavigationTarget } from "./editor/OutlinePanel";

export async function resolveLinkNavigation(
  workspaceId: string,
  source: string,
  literal: string,
  kind: "wikilink" | "markdown",
  nonce: number,
): Promise<{ path: string; headingTarget?: HeadingNavigationTarget } | null> {
  if (literal.startsWith("#")) {
    return { path: source, headingTarget: { anchor: literal.slice(1), nonce } };
  }
  const result = await bridge().linksResolve({
    workspaceId,
    source,
    literals: [{ kind, literal }],
  });
  const target = result.results[0];
  return target ? {
    path: target.path ?? target.create,
    ...(target.fragment !== null ? { headingTarget: { anchor: target.fragment, nonce } } : {}),
  } : null;
}
