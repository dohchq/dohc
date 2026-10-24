import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { serveRemoteMcp } from "./remoteMcp";

const FILE_LINK_CASES = (["view", "comment", "edit"] as const).flatMap(access =>
  [null, "pinned"].flatMap(versionId => [false, true].map(live => ({
    key: `${access}/${versionId === null ? "current" : "pinned"}/${live ? "live" : "without-live"}`,
    access, versionId, live, channel: null,
  }))));

// A Group share's link also has the Group's channel. Its files read as View
// for a read-only link and as Edit for a read-write one.
export const REMOTE_MCP_INVENTORY_CASES = [...FILE_LINK_CASES, ...(["read-only", "read-write"] as const).map(channel => ({
  key: `group/${channel}`, access: channel === "read-write" ? "edit" as const : "view" as const, versionId: null, live: true, channel,
}))];

type RemoteOptions = Parameters<typeof serveRemoteMcp>[1];
const liveLimits: NonNullable<RemoteOptions["liveLimits"]> = {
  provider: {
    frames: { receive: { maxFrameBytes: 1024, maxStateVectorBytes: 4096, maxUpdateBytes: 8192, maxSyncBytes: 16384 },
      maxQueuedBytes: 16384, maxQueuedFrames: 64, maxControlBytes: 4096, maxControlFrames: 8, maxAssemblyBytes: 16384 },
    maxPendingUpdateBytes: 16384, maxPendingUpdates: 8, maxDeliveryAttempts: 4,
  },
  maxHttpResponseBytes: 16384, maxSocketBufferedBytes: 16384, connectTimeoutMs: 2000, sendTimeoutMs: 500, drainPollMs: 10,
};
const unexpectedCall = async (): Promise<never> => { throw new Error("Inventory must not call a live host."); };
const linkLive: NonNullable<RemoteOptions["linkLive"]> = {
  handle: unexpectedCall, resolveSession: unexpectedCall, openHostRoute: unexpectedCall, openMaterialRoute: unexpectedCall,
};

// Exercises the actual remoteMcp registration and HTTP transport, after admission.
// No tools are called. The only relay response is the admitted share metadata, with its channel if any.
export async function advertisedRemoteTools({ access, versionId, live, channel }: typeof REMOTE_MCP_INVENTORY_CASES[number]) {
  const client = new Client({ name: "main-inventory", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("https://share.example.test/mcp"), {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const result = await serveRemoteMcp(request, {
          discriminator: "main-inventory", cookie: "", signal: request.signal, deadlineAtMs: Date.now() + 30_000,
          admitLargeBody: () => () => {},
          ...(live ? { linkLive, liveLimits } : {}),
          request: async path => {
            if (path !== "/api/view/meta") throw new Error(`Unexpected inventory request: ${path}`);
            return Response.json({ ok: true, access, effectiveSelector: { access, versionId, paths: [] },
              ...(channel === null ? {} : { channel: { channelWireId: "wire", access: channel } }) });
          },
        });
        return new Response(result.body, { status: result.status, headers: result.headers });
      },
    }));
    return (await client.listTools()).tools.map(({ name, inputSchema }) => ({ name, inputSchema }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally { await client.close(); }
}
