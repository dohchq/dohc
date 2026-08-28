import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AcceptShareHandoffPayload,
  DismissShareHandoffPayload,
  ShareHandoffStatus,
} from "./ipc/bridgeContract";
import {
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
          : status === "done"
            ? { status, statusId: "status-1", shareId: "share-1" }
            : { status, statusId: "status-1" };
      expect(parseShareHandoffStatus(value)).toEqual(value);
      expect(ShareHandoffStatus.parse(value)).toEqual(value);
    }

    for (const status of SHARE_HANDOFF_STATUSES.filter(
      (value) => value !== "idle" && value !== "done",
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

  it("triggers after startup warm and completed login adoption, not inside the clear seam", () => {
    const startupWarm = mainSource.indexOf("void warmCredentialCache().then(() => {");
    expect(startupWarm).toBeGreaterThanOrEqual(0);
    expect(mainSource.slice(startupWarm, startupWarm + 250)).toContain(
      "shareHandoffRedemption.credentialsChanged();",
    );

    const pollStart = mainSource.indexOf("ipcMain.handle(CHANNELS.cloudLoginPoll");
    const pollEnd = mainSource.indexOf("ipcMain.handle(CHANNELS.cloudStatus", pollStart);
    const poll = mainSource.slice(pollStart, pollEnd);
    const adoptionStart = poll.indexOf("await adoptCompletedCloudLoginSession({");
    const adoptionEnd = poll.indexOf("\n      });", adoptionStart);
    expect(adoptionStart).toBeGreaterThanOrEqual(0);
    expect(adoptionEnd).toBeGreaterThan(adoptionStart);
    expect(poll.slice(adoptionStart, adoptionEnd)).not.toContain(
      "shareHandoffRedemption.credentialsChanged()",
    );
    expect(poll.slice(adoptionEnd)).toContain(
      "shareHandoffRedemption.credentialsChanged();",
    );
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
