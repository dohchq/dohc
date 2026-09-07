import { describe, expect, it } from "vitest";
import {
  AcceptShareHandoffPayload,
  DismissShareHandoffPayload,
  ShareHandoffStatus,
} from "./ipc/bridgeContract";

const STATUSES = ShareHandoffStatus.options.map((option) => option.shape.status.value);

describe("share handoff status bridge", () => {
  it("accepts only the closed status union with a bounded identity while visible", () => {
    for (const status of STATUSES) {
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
      expect(ShareHandoffStatus.parse(value)).toEqual(value);
    }

    for (const status of STATUSES.filter(
      (value) =>
        value !== "idle" &&
        value !== "done" &&
        value !== "failed-wrong-server",
    )) {
      expect(ShareHandoffStatus.safeParse({ status }).success).toBe(false);
    }
    expect(
      ShareHandoffStatus.safeParse({ status: "idle", statusId: "status-1" })
        .success,
    ).toBe(false);
    expect(
      ShareHandoffStatus.safeParse({
        status: "waiting-for-acceptance",
        statusId: "status-1",
        email: "",
      }).success,
    ).toBe(false);
    expect(
      ShareHandoffStatus.safeParse({
        status: "waiting-for-acceptance",
        statusId: "status-1",
        email: "x".repeat(321),
      }).success,
    ).toBe(false);
    expect(
      ShareHandoffStatus.safeParse({ status: "done", statusId: "status-1" })
        .success,
    ).toBe(false);
    for (const linkRelayUrl of ["", "x".repeat(2049)]) {
      expect(
        ShareHandoffStatus.safeParse({
          status: "failed-wrong-server",
          statusId: "status-1",
          linkRelayUrl,
        }).success,
      ).toBe(false);
    }
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
      expect(ShareHandoffStatus.safeParse(raw).success).toBe(false);
      const acceptance = {
        status: "waiting-for-acceptance",
        statusId: "status-1",
        email: "current@dohc.test",
        [field]: "secret",
      };
      expect(ShareHandoffStatus.safeParse(acceptance).success).toBe(false);
    },
  );

  it("permits linkRelayUrl only on the wrong-server status", () => {
    const mismatch = {
      status: "failed-wrong-server",
      statusId: "status-1",
      linkRelayUrl: "https://relay-a.example",
    };
    expect(ShareHandoffStatus.parse(mismatch)).toEqual(mismatch);

    for (const status of ["idle", "waiting-for-sign-in", "redeeming"] as const) {
      const raw = {
        status,
        ...(status === "idle" ? {} : { statusId: "status-1" }),
        linkRelayUrl: "https://relay-a.example",
      };
      expect(ShareHandoffStatus.safeParse(raw).success).toBe(false);
    }
    const genericRelay = { ...mismatch, relayUrl: mismatch.linkRelayUrl };
    expect(ShareHandoffStatus.safeParse(genericRelay).success).toBe(false);
  });

  it("rejects unknown fields, states, impostors, and malformed share ids", () => {
    expect(ShareHandoffStatus.safeParse({ status: "idle", extra: true }).success).toBe(false);
    expect(ShareHandoffStatus.safeParse({ status: "unknown" }).success).toBe(false);
    expect(
      ShareHandoffStatus.safeParse({ status: new String("idle") }).success,
    ).toBe(false);
    expect(
      ShareHandoffStatus.safeParse({ status: "redeeming", statusId: "x".repeat(201) })
        .success,
    ).toBe(false);
    expect(
      ShareHandoffStatus.safeParse({ status: "done", statusId: "status-1", shareId: "" })
        .success,
    ).toBe(false);
    expect(
      ShareHandoffStatus.safeParse({
        status: "done",
        statusId: "status-1",
        shareId: "x".repeat(201),
      }).success,
    ).toBe(false);
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
