export function createWorkspaceFileProtocolHandler<Workspace>({
  findWorkspace,
  readOwnedWorkspaceAsset,
}: {
  findWorkspace: (workspaceId: string) => Workspace | null;
  readOwnedWorkspaceAsset: (
    workspace: Workspace,
    relativePath: string,
  ) => Promise<{ bytes: Buffer; mediaType: string }>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const url = new URL(request.url);
      const workspace = findWorkspace(url.hostname);
      if (!workspace) return new Response("Unknown workspace", { status: 404 });
      const relPath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      const { bytes, mediaType } = await readOwnedWorkspaceAsset(
        workspace,
        relPath,
      );
      // A Uint8Array VIEW over the Buffer's memory — not a second full copy.
      // (Node Buffers are ArrayBuffer-backed; the cast narrows the generic
      // ArrayBufferLike that TS 5.9 infers from .buffer.)
      const body = new Uint8Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ) as Uint8Array<ArrayBuffer>;
      const allowOrigin = trustedDohcFileCorsOrigin(request);
      const headers = new Headers({
        "content-type": mediaType,
        // Never let served workspace bytes be sniffed into active content.
        "x-content-type-options": "nosniff",
      });
      if (allowOrigin) {
        // The renderer fetch()es text files from this scheme; a custom
        // scheme is a distinct origin, so only allow the trusted renderer.
        headers.set("access-control-allow-origin", allowOrigin);
      }
      return new Response(body, {
        headers,
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
}

function trustedDohcFileCorsOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const devRendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (devRendererUrl) {
    try {
      return new URL(devRendererUrl).origin === origin ? origin : null;
    } catch {
      return null;
    }
  }
  return origin === "file://" || origin === "null" ? origin : null;
}
