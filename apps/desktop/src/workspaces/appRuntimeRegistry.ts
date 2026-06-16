export interface RuntimeDocumentEntry {
  html: string;
  script: string;
  expiresAt: number;
}

const RUNTIME_DOCUMENT_TTL_MS = 10 * 60 * 1000;
const MAX_RUNTIME_DOCUMENTS = 128;
const runtimeDocuments = new Map<string, RuntimeDocumentEntry>();
let runtimeServerOrigin: string | null = null;

export function runtimeOrigin(): string | null {
  return runtimeServerOrigin;
}

export function setRuntimeOrigin(origin: string): void {
  runtimeServerOrigin = origin;
}

function pruneRuntimeDocuments(now = Date.now()): void {
  for (const [token, entry] of runtimeDocuments) {
    if (entry.expiresAt <= now) runtimeDocuments.delete(token);
  }
}

export function registerRuntimeDocument(
  token: string,
  document: { html: string; script: string },
): void {
  pruneRuntimeDocuments();
  while (runtimeDocuments.size >= MAX_RUNTIME_DOCUMENTS) {
    const oldest = runtimeDocuments.keys().next().value;
    if (!oldest) break;
    runtimeDocuments.delete(oldest);
  }
  runtimeDocuments.set(token, {
    ...document,
    expiresAt: Date.now() + RUNTIME_DOCUMENT_TTL_MS,
  });
}

export function runtimeDocument(token: string): string | null {
  pruneRuntimeDocuments();
  return runtimeDocuments.get(token)?.html ?? null;
}

export function runtimeScript(token: string): string | null {
  pruneRuntimeDocuments();
  return runtimeDocuments.get(token)?.script ?? null;
}

export function isAppRuntimeFrameUrl(targetUrl: string): boolean {
  const origin = runtimeOrigin();
  if (!origin) return false;
  pruneRuntimeDocuments();
  try {
    const url = new URL(targetUrl);
    return (
      url.origin === origin &&
      /^\/[0-9a-f-]{36}\/index\.html$/.test(url.pathname) &&
      runtimeDocuments.has(url.pathname.split("/")[1])
    );
  } catch {
    return false;
  }
}
