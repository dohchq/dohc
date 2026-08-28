import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AcceptShareHandoffPayload,
  DismissShareHandoffPayload,
  ShareHandoffStatus,
} from "./ipc/bridgeContract";
import {
  CHANNELS,
  parseShareHandoffStatus,
  SHARE_HANDOFF_STATUSES,
} from "./ipc/channels";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const preloadSource = readFileSync(
  new URL("./preload.ts", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const sharedByMeSource = readFileSync(
  new URL("./renderer/settings/SharedByMeList.tsx", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const sharedWithMeSource = readFileSync(
  new URL("./renderer/settings/SharedWithMeList.tsx", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

function mainHandlerSource(channel: string): string {
  const marker = `CHANNELS.${channel},`;
  const markerAt = mainSource.indexOf(marker);
  if (markerAt < 0) throw new Error(`Missing IPC handler for ${channel}`);
  const start = mainSource.lastIndexOf("ipcMain.handle(", markerAt);
  if (start < 0) throw new Error(`Missing IPC handler for ${channel}`);
  const next = mainSource.indexOf("ipcMain.handle(", markerAt + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

describe("share handoff status bridge", () => {
  it("accepts only the closed status union with a bounded identity while visible", () => {
    for (const status of SHARE_HANDOFF_STATUSES) {
      const value =
        status === "idle"
          ? { status }
          : status === "waiting-for-acceptance"
            ? {
                status,
                statusId: "status-1",
                email: "current@dohc.test",
              }
          : status === "failed-wrong-server"
            ? {
                status,
                statusId: "status-1",
                linkRelayUrl: "https://relay-a.example",
              }
          : status === "done"
            ? { status, statusId: "status-1", shareId: "share-1" }
            : { status, statusId: "status-1" };
      expect(parseShareHandoffStatus(value)).toEqual(value);
      expect(ShareHandoffStatus.parse(value)).toEqual(value);
    }

    for (const status of SHARE_HANDOFF_STATUSES.filter(
      (value) =>
        value !== "idle" &&
        value !== "done" &&
        value !== "failed-wrong-server",
    )) {
      expect(parseShareHandoffStatus({ status })).toBeNull();
      expect(ShareHandoffStatus.safeParse({ status }).success).toBe(false);
    }
    expect(
      parseShareHandoffStatus({ status: "idle", statusId: "status-1" }),
    ).toBeNull();
    expect(
      ShareHandoffStatus.safeParse({ status: "idle", statusId: "status-1" })
        .success,
    ).toBe(false);
    expect(
      parseShareHandoffStatus({
        status: "waiting-for-acceptance",
        statusId: "status-1",
        email: "",
      }),
    ).toBeNull();
    expect(
      ShareHandoffStatus.safeParse({
        status: "waiting-for-acceptance",
        statusId: "status-1",
        email: "x".repeat(321),
      }).success,
    ).toBe(false);
    expect(
      parseShareHandoffStatus({
        status: "done",
        statusId: "status-1",
      }),
    ).toBeNull();
    expect(
      ShareHandoffStatus.safeParse({ status: "done", statusId: "status-1" })
        .success,
    ).toBe(false);
    for (const linkRelayUrl of ["", "x".repeat(2049)]) {
      expect(
        parseShareHandoffStatus({
          status: "failed-wrong-server",
          statusId: "status-1",
          linkRelayUrl,
        }),
      ).toBeNull();
      expect(
        ShareHandoffStatus.safeParse({
          status: "failed-wrong-server",
          statusId: "status-1",
          linkRelayUrl,
        }).success,
      ).toBe(false);
    }
    expect(
      parseShareHandoffStatus({
        status: "failed-wrong-server",
        statusId: "status-1",
      }),
    ).toBeNull();
    expect(
      ShareHandoffStatus.safeParse({
        status: "failed-wrong-server",
        statusId: "status-1",
      }).success,
    ).toBe(false);
  });

  it.each(["code", "token", "grantId", "relayUrl", "response"])(
    "rejects the forbidden %s field from snapshots and events",
    (field) => {
      const raw = { status: "idle", [field]: "secret" };
      expect(parseShareHandoffStatus(raw)).toBeNull();
      expect(ShareHandoffStatus.safeParse(raw).success).toBe(false);
      const acceptance = {
        status: "waiting-for-acceptance",
        statusId: "status-1",
        email: "current@dohc.test",
        [field]: "secret",
      };
      expect(parseShareHandoffStatus(acceptance)).toBeNull();
      expect(ShareHandoffStatus.safeParse(acceptance).success).toBe(false);
    },
  );

  it("permits linkRelayUrl only on the wrong-server status", () => {
    const mismatch = {
      status: "failed-wrong-server",
      statusId: "status-1",
      linkRelayUrl: "https://relay-a.example",
    };
    expect(parseShareHandoffStatus(mismatch)).toEqual(mismatch);
    expect(ShareHandoffStatus.parse(mismatch)).toEqual(mismatch);

    for (const status of ["idle", "waiting-for-sign-in", "redeeming"] as const) {
      const raw = {
        status,
        ...(status === "idle" ? {} : { statusId: "status-1" }),
        linkRelayUrl: "https://relay-a.example",
      };
      expect(parseShareHandoffStatus(raw)).toBeNull();
      expect(ShareHandoffStatus.safeParse(raw).success).toBe(false);
    }
    const genericRelay = { ...mismatch, relayUrl: mismatch.linkRelayUrl };
    expect(parseShareHandoffStatus(genericRelay)).toBeNull();
    expect(ShareHandoffStatus.safeParse(genericRelay).success).toBe(false);
  });

  it("rejects unknown fields, states, inherited fields, and malformed share ids", () => {
    expect(parseShareHandoffStatus({ status: "idle", extra: true })).toBeNull();
    expect(parseShareHandoffStatus({ status: "unknown" })).toBeNull();
    expect(parseShareHandoffStatus(Object.create({ status: "idle" }))).toBeNull();
    expect(parseShareHandoffStatus({ status: new String("idle") })).toBeNull();
    expect(
      parseShareHandoffStatus({
        status: "redeeming",
        statusId: "x".repeat(201),
      }),
    ).toBeNull();
    expect(
      parseShareHandoffStatus({
        status: "done",
        statusId: "status-1",
        shareId: "",
      }),
    ).toBeNull();
    expect(
      parseShareHandoffStatus({
        status: "done",
        statusId: "status-1",
        shareId: "x".repeat(201),
      }),
    ).toBeNull();
  });

  it("requires only the captured status identity in action payloads", () => {
    expect(AcceptShareHandoffPayload.parse({ statusId: "status-1" })).toEqual({
      statusId: "status-1",
    });
    expect(DismissShareHandoffPayload.parse({ statusId: "status-1" })).toEqual({
      statusId: "status-1",
    });
    for (const payload of [
      undefined,
      {},
      { statusId: "" },
      { statusId: "x".repeat(201) },
      { statusId: "status-1", code: "secret" },
      { statusId: "status-1", token: "secret" },
    ]) {
      expect(AcceptShareHandoffPayload.safeParse(payload).success).toBe(false);
      expect(DismissShareHandoffPayload.safeParse(payload).success).toBe(false);
    }
  });

  it("validates both snapshot and event in preload and forwards only the dismissal identity", () => {
    expect(preloadSource).toContain("parseShareHandoffStatus(result)");
    expect(preloadSource).toContain("parseShareHandoffStatus(raw)");
    expect(preloadSource).toContain(
      "ipcRenderer.invoke(CHANNELS.acceptShareHandoff, payload)",
    );
    expect(preloadSource).toContain(
      "ipcRenderer.invoke(CHANNELS.retryShareHandoff)",
    );
    expect(preloadSource).toContain(
      "ipcRenderer.invoke(CHANNELS.dismissShareHandoff, payload)",
    );
    expect(preloadSource).not.toContain(
      "ipcRenderer.invoke(CHANNELS.retryShareHandoff,",
    );
  });

  it("registers strict handlers, binds dismissal to the identity, and publishes the current snapshot", () => {
    expect(mainSource).toContain("CHANNELS.getShareHandoffStatus");
    expect(mainSource).toContain("CHANNELS.acceptShareHandoff");
    expect(mainSource).toContain("CHANNELS.retryShareHandoff");
    expect(mainSource).toContain("CHANNELS.dismissShareHandoff");
    expect(mainSource).toContain("assertNoShareHandoffArguments(args)");
    expect(mainSource).toContain("AcceptShareHandoffPayload.parse(args[0])");
    expect(mainSource).toContain("DismissShareHandoffPayload.parse(args[0])");
    expect(mainSource).toContain("shareHandoffRedemption.accept(input.statusId)");
    expect(mainSource).toContain("shareHandoffRedemption.dismiss(input.statusId)");
    expect(mainSource).toContain("shareHandoffRedemption.status()");
  });
});

describe("share handoff credential and ingress wiring", () => {
  it("bounds redemption requests before the coordinator is initialized", () => {
    const timeoutDeclaration =
      "const SHARE_HANDOFF_REDEMPTION_FETCH_TIMEOUT_MS = 15_000;";
    const timeoutAt = mainSource.indexOf(timeoutDeclaration);
    const creationAt = mainSource.indexOf(
      "const shareHandoffRedemption = createShareHandoffRedemptionCoordinator({",
    );
    const creation = mainSource.slice(creationAt, creationAt + 1400);

    expect(timeoutAt).toBeGreaterThanOrEqual(0);
    expect(creationAt).toBeGreaterThan(timeoutAt);
    expect(creation).toContain(
      "fetch: relayFetchWithTimeout(SHARE_HANDOFF_REDEMPTION_FETCH_TIMEOUT_MS),",
    );
    expect(creation).not.toContain("fetch: (input, init) => fetch(input, init)");
  });

  it("schedules redemption after cold, open-url, and second-instance capture", () => {
    expect(mainSource.match(/shareHandoffRedemption\.pendingCodeChanged\(\)/gu)).toHaveLength(
      3,
    );
  });

  it("notifies once from the credential-cache change seam", () => {
    const callbackStart = mainSource.indexOf(
      "new CredentialSessionCache<CloudSessionCredentials>((snapshot) => {",
    );
    const callbackEnd = mainSource.indexOf("\n  });", callbackStart);
    expect(callbackStart).toBeGreaterThanOrEqual(0);
    expect(callbackEnd).toBeGreaterThan(callbackStart);
    expect(mainSource.slice(callbackStart, callbackEnd)).toContain(
      "shareHandoffRedemption.credentialsChanged();",
    );
    expect(
      mainSource.match(/shareHandoffRedemption\.credentialsChanged\(\);/gu),
    ).toHaveLength(1);
  });

  it("routes 401 through the existing current-session-aware full invalidation", () => {
    const creationAt = mainSource.indexOf(
      "createShareHandoffRedemptionCoordinator({",
    );
    const creation = mainSource.slice(creationAt, creationAt + 1400);
    expect(creationAt).toBeGreaterThanOrEqual(0);
    expect(creation).toContain("handleRelayUnauthorized({");
    expect(creation).toContain("clearCachedCredentials:");
    expect(creation).toContain("notifySessionChanging:");
    expect(creation).toContain("notifyCloudSessionChanged:");
    expect(creation).toContain("invalidatePersistedSessionIf:");
  });
});

describe("exact received-share bridge", () => {
  it("uses one typed channel from preload to a trusted exact route", () => {
    expect(CHANNELS.getRelayReceivedShare).toBe(
      "desktop:get-relay-received-share",
    );
    expect(preloadSource).toContain(
      "ipcRenderer.invoke(CHANNELS.getRelayReceivedShare, payload)",
    );

    const handler = mainHandlerSource("getRelayReceivedShare");
    expect(handler).toContain("assertTrustedSender(event);");
    expect(handler).toContain("GetRelayReceivedSharePayload.parse(payload)");
    expect(handler).toContain("const credentials = cachedCredentials;");
    expect(handler).toContain("awaitCredentialGeneration({");
    expect(handler).toContain(
      "`/sync/shares/${encodeURIComponent(input.shareId)}`",
    );
    expect(handler).toContain("relayShareJsonWithCredentials<unknown>(");
    expect(handler).toContain("{ retainNotFound: true }");
    expect(handler).not.toContain('relayShareJson("/sync/shares")');
  });

  it("attaches only the requested id and trusted credential relay to a parsed received row", () => {
    const handler = mainHandlerSource("getRelayReceivedShare");
    const bodySpreadAt = handler.indexOf("? body\n        : {}),");
    const codeAt = handler.indexOf("shareCode: buildShareCode({");

    expect(handler).toContain("RelayShareReceivedRow.parse({");
    expect(handler).toContain("shareId: input.shareId,");
    expect(handler).toContain("relayUrl: credentials.relayUrl!,");
    expect(handler).toContain("received.shareId !== input.shareId");
    expect(handler).toContain(
      "GetRelayReceivedShareResult.parse({ found: true, share: received })",
    );
    expect(bodySpreadAt).toBeGreaterThan(-1);
    expect(codeAt).toBeGreaterThan(bodySpreadAt);
    expect(handler).not.toMatch(/relayUrl:\s*(?:body|result|received)/u);
  });

  it("classifies only a structured relay not_found response as missing", () => {
    const helperStart = mainSource.indexOf(
      "async function relayShareJsonWithCredentials<T>(",
    );
    const helperEnd = mainSource.indexOf(
      "async function relayShareJson<T>",
      helperStart,
    );
    const helper = mainSource.slice(helperStart, helperEnd);
    const handler = mainHandlerSource("getRelayReceivedShare");

    expect(helper).toContain('"retainNotFound" in options');
    expect(helper).toContain("response.status === 404");
    expect(helper).toContain("data?.ok === false");
    expect(helper).toContain('data.code === "not_found"');
    expect(helper).toContain('return { kind: "missing" };');
    expect(handler).toContain('if (result.kind === "missing")');
    expect(handler).toContain(
      "GetRelayReceivedShareResult.parse({ found: false })",
    );
    expect(handler).not.toContain("error.message");
    expect(handler).not.toContain("catch (");
    expect(handler).toContain("RelayShareReceivedRow.parse({");
  });

  it("leaves Settings on the capped inventory method", () => {
    for (const source of [sharedByMeSource, sharedWithMeSource]) {
      expect(source).toContain(".listRelayShares()");
      expect(source).not.toContain(".getRelayReceivedShare(");
    }
  });
});
