// What an app's WebView may load, and the only links it hands to the system browser.
//
// The WebView loads the exact bootstrap address once, at the top, as native code submits it. After that it loads only
// `about:srcdoc` and `about:blank` in a frame: the bootstrap puts the app in a srcdoc frame and opens nothing else.
// Every other load is refused, the bootstrap again included, and no scheme reaches the system from here. The rule never
// reads `navigationType` or a load event, which the app's frame can fire itself.

export interface LoadRequest {
  readonly url: string;
  /** react-native-webview's guess, from the address alone. It only narrows what's allowed. */
  readonly isTopFrame: boolean;
}

/** One launch's rule. A new launch, with its new WebView, makes a new one. */
export function createNavigationRule(bootstrap: string): (request: LoadRequest) => boolean {
  let started = false;
  return (request) => {
    if (!started) {
      started = request.isTopFrame && request.url === bootstrap;
      return started;
    }
    return !request.isTopFrame && (request.url === "about:srcdoc" || request.url === "about:blank");
  };
}

/** A host without the one trailing dot that names the same host. */
const bare = (host: string) => host.replace(/\.$/, "");
const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/**
 * The address to open in the system browser for a link the person tapped in the app, or null. Only an HTTPS address
 * opens, never one on the dohc server or the app domain, where it could act as the person. `bootstrap` is on a random
 * host under the app domain.
 */
export function externalLink(url: string, bootstrap: string, serverOrigin: string): string | null {
  return outsideLink(
    url,
    serverOrigin,
    bare(new URL(bootstrap).hostname).split(".").slice(1).join("."),
  );
}

/**
 * The address to open in the system browser for a link the person tapped, or null: only HTTPS, never on the dohc
 * server or, when one is given, the app domain.
 */
export function outsideLink(url: string, serverOrigin: string, appDomain = ""): string | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  const host = bare(target.hostname);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    !host ||
    (appDomain && within(host, appDomain)) ||
    within(host, bare(new URL(serverOrigin).hostname))
  )
    return null;
  return target.href;
}
