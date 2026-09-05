import { expect, test } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { RelayFilePeer } from "../src/testing/relayFilePeer";
import { claimRelayWorkspace, relayJson } from "./helpers/relayPeer";
import { spawnSyncRelay, type SyncRelayHandle } from "./helpers/syncRelay";
import { createTempWorkspace } from "./helpers/workspace";

// A collection under a share, against the create-only contract in
// docs/plans/share-links.md ("The create-only collection contract").
//
// Relay-direct: collections ride the file share substrate, a cross-device
// granter edit converges to a link holder, and revocation stops every
// collection operation over the share. The create-only grant itself is
// specified in that plan and not yet built.

const GRANTER_TOKEN = "test:e2e-granter";
const RECIPIENT_TOKEN = "test:e2e-recipient";
const RECIPIENT_EMAIL = "e2e-recipient@dohc.test";
const WORKSPACE_ID = "collection-share-conformance-e2e";
const COLLECTION_PATH = "trips";

const SCHEMA_TEXT = [
  "name: Trips",
  "fields:",
  "  destination:",
  "    type: text",
  "  status:",
  "    type: select",
  "    options: [planned, booked, done]",
  "",
].join("\n");
const RECORD_V1 = [
  "---",
  "id: rec_c5h66p35cpj6ast5cdj6a833",
  "destination: Lisbon",
  "status: planned",
  "---",
  "",
  "# Lisbon",
  "",
  "The tram 28 draft.",
  "",
].join("\n");
const RECORD_V2 = RECORD_V1.replace("status: planned", "status: booked");
const PRIVATE_TEXT = "The kraken ledger stays private.\n";

type RawRelayResponse = { status: number; body: string };

async function publicRelayRequest(
  baseUrl: string,
  path: string,
  init: RequestInit,
): Promise<RawRelayResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.text() };
}

async function exchangeViewLink(
  baseUrl: string,
  relayExchangeKey: string,
  secret: string,
): Promise<RawRelayResponse> {
  return publicRelayRequest(baseUrl, "/sync/link-exchange", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dohc-relay-exchange-key": relayExchangeKey,
    },
    body: JSON.stringify({ secret }),
  });
}

async function readViewLink(
  baseUrl: string,
  capability: string,
  path: string,
): Promise<RawRelayResponse> {
  return publicRelayRequest(baseUrl, path, {
    method: "GET",
    headers: { authorization: `LinkCapability ${capability}` },
  });
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type LinkLog = {
  ops?: Array<{ opKind?: unknown; payload?: Record<string, unknown> }>;
};

function logOpForDigest(
  log: LinkLog,
  digest: string,
): Record<string, unknown> | undefined {
  return log.ops?.find(
    (op) =>
      op.opKind === "moment.append" && op.payload?.payloadAfterBlobSha256 === digest,
  )?.payload;
}

// A failed run must not retain the one-time link URL in diagnostics.
test.use({ screenshot: "off", trace: "off" });

test(
  "a shared collection reaches a link holder, converges a cross-device edit, and revocation stops it",
  async () => {
    test.setTimeout(180_000);
    const temp = await createTempWorkspace();
    const linkKey = randomBytes(32).toString("base64url");
    const relayExchangeKey = randomBytes(32).toString("base64url");
    let relay: SyncRelayHandle | null = null;

    try {
      relay = await spawnSyncRelay({
        dbPath: join(temp.baseDir, "relay.sqlite"),
        linkBoundary: {
          linkKey,
          relayExchangeKey,
          publicViewerOrigin: "http://127.0.0.1:4173",
        },
      });
      await claimRelayWorkspace({
        baseUrl: relay.baseUrl,
        token: GRANTER_TOKEN,
        workspaceId: WORKSPACE_ID,
      });

      // Device A of the granter seeds the collection and a private file.
      const deviceA = new RelayFilePeer({
        baseUrl: relay.baseUrl,
        token: GRANTER_TOKEN,
        workspaceId: WORKSPACE_ID,
        originId: "granter-device-a",
      });
      const heads = await deviceA.writeTextFiles([
        { path: `${COLLECTION_PATH}/collection.yaml`, text: SCHEMA_TEXT },
        { path: `${COLLECTION_PATH}/lisbon.md`, text: RECORD_V1 },
        { path: "private/ledger.md", text: PRIVATE_TEXT },
      ]);
      const recordHead = heads[1]!;

      // The share selects the collection folder.
      const create = await relayJson(
        relay.baseUrl,
        GRANTER_TOKEN,
        `/sync/${WORKSPACE_ID}/shares`,
        {
          method: "POST",
          body: JSON.stringify({
            recipientEmail: RECIPIENT_EMAIL,
            paths: [COLLECTION_PATH],
            access: "view",
          }),
        },
      );
      expect(create.status).toBe(200);
      const shareId = (JSON.parse(create.body) as { shareId: string }).shareId;

      // The named recipient reaches the collection through the share.
      const namedLog = await relayJson(
        relay.baseUrl,
        RECIPIENT_TOKEN,
        `/sync/shares/${shareId}/log?since=0&limit=500`,
      );
      expect(namedLog.status).toBe(200);
      expect(namedLog.body.includes("ledger")).toBe(false);

      // A View link on the same share, created relay-side.
      const linkCreate = await relayJson(
        relay.baseUrl,
        GRANTER_TOKEN,
        `/sync/${WORKSPACE_ID}/shares/${shareId}/links`,
        { method: "POST", body: JSON.stringify({ access: "view" }) },
      );
      expect(linkCreate.status).toBe(200);
      const linkUrl = (JSON.parse(linkCreate.body) as { url: string }).url;
      const secret = new URL(linkUrl).hash.slice(1);
      expect(/^[A-Za-z0-9_-]{43}$/u.test(secret)).toBe(true);

      // Never-valid baselines, captured before revocation for byte-identity.
      const neverValidExchange = await exchangeViewLink(
        relay.baseUrl,
        relayExchangeKey,
        "A".repeat(43),
      );
      const neverValidRead = await readViewLink(
        relay.baseUrl,
        "A".repeat(43),
        "/sync/link/share",
      );
      const missingNamedShare = await relayJson(
        relay.baseUrl,
        RECIPIENT_TOKEN,
        "/sync/shares/never-valid/log?since=0&limit=500",
      );
      expect(missingNamedShare.status).toBe(404);

      const exchange = await exchangeViewLink(relay.baseUrl, relayExchangeKey, secret);
      expect(exchange.status).toBe(200);
      const capability = (JSON.parse(exchange.body) as { capabilityToken: string })
        .capabilityToken;

      // The link holder reads the schema and the record, and nothing private.
      const linkLogResponse = await readViewLink(
        relay.baseUrl,
        capability,
        "/sync/link/log?since=0&limit=500",
      );
      expect(linkLogResponse.status).toBe(200);
      const linkLog = JSON.parse(linkLogResponse.body) as LinkLog;
      expect(logOpForDigest(linkLog, sha256Hex(SCHEMA_TEXT))).toBeDefined();
      expect(logOpForDigest(linkLog, sha256Hex(RECORD_V1))).toBeDefined();
      expect(linkLogResponse.body.includes("ledger")).toBe(false);

      const schemaBlob = await readViewLink(
        relay.baseUrl,
        capability,
        `/sync/link/blobs/${sha256Hex(SCHEMA_TEXT)}`,
      );
      expect(schemaBlob.status).toBe(200);
      expect(schemaBlob.body).toBe(SCHEMA_TEXT);
      const privateBlob = await readViewLink(
        relay.baseUrl,
        capability,
        `/sync/link/blobs/${sha256Hex(PRIVATE_TEXT)}`,
      );
      expect(privateBlob.status).toBe(404);

      // Device B of the granter edits the record field; the edit converges
      // through the relay and the link holder reads the converged state.
      const deviceB = new RelayFilePeer({
        baseUrl: relay.baseUrl,
        token: GRANTER_TOKEN,
        workspaceId: WORKSPACE_ID,
        originId: "granter-device-b",
      });
      await deviceB.writeText({
        path: `${COLLECTION_PATH}/lisbon.md`,
        text: RECORD_V2,
        beforeOverride: recordHead,
      });

      const convergedLogResponse = await readViewLink(
        relay.baseUrl,
        capability,
        "/sync/link/log?since=0&limit=500",
      );
      expect(convergedLogResponse.status).toBe(200);
      const convergedLog = JSON.parse(convergedLogResponse.body) as LinkLog;
      const convergedOp = logOpForDigest(convergedLog, sha256Hex(RECORD_V2));
      expect(convergedOp).toBeDefined();
      expect(convergedOp?.payloadBeforeBlobSha256).toBe(sha256Hex(RECORD_V1));
      const convergedBlob = await readViewLink(
        relay.baseUrl,
        capability,
        `/sync/link/blobs/${sha256Hex(RECORD_V2)}`,
      );
      expect(convergedBlob.status).toBe(200);
      expect(convergedBlob.body).toBe(RECORD_V2);

      // Revocation stops every collection operation over the share: the link
      // and the named grant become byte-identical to never-valid.
      const revoke = await relayJson(
        relay.baseUrl,
        GRANTER_TOKEN,
        `/sync/shares/${shareId}/revoke`,
        { method: "POST" },
      );
      expect(revoke.status).toBe(200);

      expect(await exchangeViewLink(relay.baseUrl, relayExchangeKey, secret)).toEqual(
        neverValidExchange,
      );
      expect(await readViewLink(relay.baseUrl, capability, "/sync/link/share")).toEqual(
        neverValidRead,
      );
      expect(
        await relayJson(
          relay.baseUrl,
          RECIPIENT_TOKEN,
          `/sync/shares/${shareId}/log?since=0&limit=500`,
        ),
      ).toEqual(missingNamedShare);
    } finally {
      await relay?.stop();
      await temp.cleanup();
    }
  },
);
