import { isAbsolute } from "node:path";

export interface MainWindowWebPreferences {
  preload: string;
  nodeIntegration: false;
  contextIsolation: true;
  sandbox: true;
}

export function createMainWindowWebPreferences(
  preloadPath: string,
): MainWindowWebPreferences {
  if (!isAbsolute(preloadPath)) {
    throw new Error(`Preload path must be absolute, got: ${preloadPath}`);
  }
  return {
    preload: preloadPath,
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  };
}

export interface NavigationDecision {
  action: "allow" | "deny";
}

export interface NavigationPolicy {
  // Exact URL origins (scheme://host:port), compared with ===, never prefix:
  // startsWith would allow http://localhost:5173.evil.com.
  httpOrigins: string[];
  // The packaged renderer bundle directory as a file:// href prefix; a bare
  // "file://" allowance would open every local file to navigation.
  fileUrlPrefix: string | null;
}

// The renderer may only navigate within the app itself: the packaged
// bundle directory or the dev server's exact origin. Everything else,
// including unparseable URLs, is denied.
export function decideNavigation(
  targetUrl: string,
  policy: NavigationPolicy,
): NavigationDecision {
  try {
    const url = new URL(targetUrl);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return {
        action: policy.httpOrigins.includes(url.origin) ? "allow" : "deny",
      };
    }
    if (url.protocol === "file:" && policy.fileUrlPrefix) {
      return {
        action: url.href.startsWith(policy.fileUrlPrefix) ? "allow" : "deny",
      };
    }
  } catch {
    // fall through to deny
  }
  return { action: "deny" };
}

export interface WindowOpenDecision {
  action: "deny";
  openExternal: boolean;
}

// window.open never creates a BrowserWindow. http(s) targets are handed to
// the OS browser; every other scheme is dropped entirely.
export function decideWindowOpen(targetUrl: string): WindowOpenDecision {
  let openExternal = false;
  try {
    const protocol = new URL(targetUrl).protocol;
    openExternal = protocol === "https:" || protocol === "http:";
  } catch {
    openExternal = false;
  }
  return { action: "deny", openExternal };
}
