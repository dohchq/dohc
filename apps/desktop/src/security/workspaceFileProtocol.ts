import { randomBytes } from "node:crypto";

const ADMITTED_HEADER = "x-dohc-admitted";

interface RequestDetails {
  frame?: { readonly parent: unknown; readonly url: string } | null;
  requestHeaders: Record<string, string>;
}

type AdmitResponse = { cancel: true } | { requestHeaders: Record<string, string> };

export function createWorkspaceFileProtocol<Workspace>({
  findWorkspace,
  readOwnedWorkspaceAsset,
  isTrustedFrame,
}: {
  findWorkspace: (workspaceId: string) => Workspace | null;
  readOwnedWorkspaceAsset: (
    workspace: Workspace,
    relativePath: string,
  ) => Promise<{ bytes: Buffer; mediaType: string }>;
  isTrustedFrame: (frameUrl: string) => boolean;
}): {
  admit: (details: RequestDetails, callback: (response: AdmitResponse) => void) => void;
  handle: (request: Request) => Promise<Response>;
} {
  const admission = randomBytes(32).toString("base64url");
  const trustedTopFrameUrl = (frame: RequestDetails["frame"]): string | null => {
    try {
      return frame && frame.parent === null ? frame.url : null;
    } catch {
      return null;
    }
  };
  return {
    admit: (details, callback) => {
      const frameUrl = trustedTopFrameUrl(details.frame);
      if (frameUrl === null || !isTrustedFrame(frameUrl)) {
        callback({ cancel: true });
        return;
      }
      callback({ requestHeaders: { ...details.requestHeaders, [ADMITTED_HEADER]: admission } });
    },
    handle: async (request) => {
      if (request.headers.get(ADMITTED_HEADER) !== admission) {
        return new Response("Not found", { status: 404 });
      }
      try {
        const url = new URL(request.url);
        const workspace = findWorkspace(url.hostname);
        if (!workspace) return new Response("Unknown workspace", { status: 404 });
        const relPath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
        const { bytes, mediaType } = await readOwnedWorkspaceAsset(workspace, relPath);
        // A Uint8Array VIEW over the Buffer's memory — not a second full copy.
        // (Node Buffers are ArrayBuffer-backed; the cast narrows the generic
        // ArrayBufferLike that TS 5.9 infers from .buffer.)
        const body = new Uint8Array(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        ) as Uint8Array<ArrayBuffer>;
        return new Response(body, {
          headers: {
            "content-type": mediaType,
            // Never let served workspace bytes be sniffed into active content.
            "x-content-type-options": "nosniff",
          },
        });
      } catch {
        return new Response("Not found", { status: 404 });
      }
    },
  };
}
