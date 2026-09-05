import { describe, expect, it } from "vitest";
import {
  AcceptShareHandoffPayload,
  DismissShareHandoffPayload,
  ShareHandoffStatus,
} from "./ipc/bridgeContract";
import { parseShareHandoffStatus, SHARE_HANDOFF_STATUSES } from "./ipc/channels";

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
});
