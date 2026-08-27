import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ShareHandoffStatus } from "./ipc/bridgeContract";
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
  it("accepts only the closed status union and permits shareId only on done", () => {
    for (const status of SHARE_HANDOFF_STATUSES) {
      const value =
        status === "done" ? { status, shareId: "share-1" } : { status };
      expect(parseShareHandoffStatus(value)).toEqual(value);
      expect(ShareHandoffStatus.parse(value)).toEqual(value);
    }

    for (const status of SHARE_HANDOFF_STATUSES.filter((value) => value !== "done")) {
      expect(parseShareHandoffStatus({ status, shareId: "share-1" })).toBeNull();
      expect(ShareHandoffStatus.safeParse({ status, shareId: "share-1" }).success).toBe(
        false,
      );
    }
    expect(parseShareHandoffStatus({ status: "done" })).toBeNull();
    expect(ShareHandoffStatus.safeParse({ status: "done" }).success).toBe(false);
  });

  it.each(["code", "token", "grantId", "relayUrl", "response"])(
    "rejects the forbidden %s field from snapshots and events",
    (field) => {
      const raw = { status: "idle", [field]: "secret" };
      expect(parseShareHandoffStatus(raw)).toBeNull();
      expect(ShareHandoffStatus.safeParse(raw).success).toBe(false);
    },
  );

  it("rejects unknown fields, states, inherited fields, and malformed share ids", () => {
    expect(parseShareHandoffStatus({ status: "idle", extra: true })).toBeNull();
    expect(parseShareHandoffStatus({ status: "unknown" })).toBeNull();
    expect(parseShareHandoffStatus(Object.create({ status: "idle" }))).toBeNull();
    expect(parseShareHandoffStatus({ status: new String("idle") })).toBeNull();
    expect(parseShareHandoffStatus({ status: "done", shareId: "" })).toBeNull();
    expect(
      parseShareHandoffStatus({ status: "done", shareId: "x".repeat(201) }),
    ).toBeNull();
  });

  it("validates both snapshot and event in preload and invokes retry/dismiss without payloads", () => {
    expect(preloadSource).toContain("parseShareHandoffStatus(result)");
    expect(preloadSource).toContain("parseShareHandoffStatus(raw)");
    expect(preloadSource).toContain(
      "ipcRenderer.invoke(CHANNELS.retryShareHandoff)",
    );
    expect(preloadSource).toContain(
      "ipcRenderer.invoke(CHANNELS.dismissShareHandoff)",
    );
    expect(preloadSource).not.toContain(
      "ipcRenderer.invoke(CHANNELS.retryShareHandoff,",
    );
    expect(preloadSource).not.toContain(
      "ipcRenderer.invoke(CHANNELS.dismissShareHandoff,",
    );
  });

  it("registers strict parameterless handlers and publishes the current snapshot", () => {
    expect(mainSource).toContain("CHANNELS.getShareHandoffStatus");
    expect(mainSource).toContain("CHANNELS.retryShareHandoff");
    expect(mainSource).toContain("CHANNELS.dismissShareHandoff");
    expect(mainSource).toContain("assertNoShareHandoffArguments(args)");
    expect(mainSource).toContain("shareHandoffRedemption.status()");
  });
});

describe("share handoff credential and ingress wiring", () => {
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
