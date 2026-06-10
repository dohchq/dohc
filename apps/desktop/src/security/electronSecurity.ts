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

// window.open never creates a BrowserWindow (callers always deny). http(s)
// targets are handed to the OS browser; every other scheme is dropped.
export function shouldOpenExternally(targetUrl: string): boolean {
  try {
    const protocol = new URL(targetUrl).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

// The dev-server URL is only honored in unpackaged dev builds and only when
// it points at loopback: a packaged app launched with ELECTRON_RENDERER_URL
// set must never load (or IPC-trust) an arbitrary origin.
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function validateDevServerUrl(
  raw: string | undefined,
  isPackaged: boolean,
): string | null {
  if (!raw || isPackaged) return null;
  try {
    const url = new URL(raw);
    const httpLike = url.protocol === "http:" || url.protocol === "https:";
    return httpLike && LOOPBACK_HOSTS.has(url.hostname) ? raw : null;
  } catch {
    return null;
  }
}
