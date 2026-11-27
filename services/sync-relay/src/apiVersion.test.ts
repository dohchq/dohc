import { describe, expect, it } from "vitest";
import {
  RELAY_API_VERSION,
  RELAY_API_VERSION_HEADER,
} from "@dohc/workspace-contracts/relay-values";
import {
  ENGINE_API_MIN_SETTING,
  RELAY_API_VERSIONS,
  engineApiMinimum,
  relayApiVersionRefusal,
  relayApiVersionsFor,
} from "./apiVersion";
import { AUTOMATION_REPLICA_BEARER_PREFIX } from "./automationReplicaCredential";

function headers(version?: string): Headers {
  return new Headers(version === undefined ? {} : { [RELAY_API_VERSION_HEADER]: version });
}

function refusalCode(
  path: string,
  engineMin: number,
  version?: string,
  authorization?: string,
): string | null {
  const request = new Request(`http://relay.test${path}`, { headers: headers(version) });
  if (authorization) request.headers.set("authorization", authorization);
  return (
    relayApiVersionRefusal(request.headers, relayApiVersionsFor(request, engineMin))?.code ?? null
  );
}

const SHA = "a".repeat(64);
const ENGINE_PATHS = [
  "/sync/workspaces",
  "/sync/ws-a/log",
  "/sync/ws-a/log/origin-a/3",
  "/sync/ws-a/epoch",
  "/sync/ws-a/keys",
  "/sync/ws-a/blobs/have",
  `/sync/ws-a/blobs/${SHA}`,
  "/sync/shares/share-a/log",
  `/sync/shares/share-a/blobs/${SHA}`,
  "/sync/shares/share-a/proposals",
  "/sync/shares/share-a/collection-writes",
  "/sync/ws-a/live-notes",
];

describe("relay API version", () => {
  it("serves versions 1 and 2, the version clients send, and a request that names none", () => {
    expect(RELAY_API_VERSIONS).toEqual({ min: 1, max: 2 });
    expect(RELAY_API_VERSION).toBeLessThanOrEqual(RELAY_API_VERSIONS.max);
    expect(relayApiVersionRefusal(headers(String(RELAY_API_VERSION)))).toBeNull();
    expect(relayApiVersionRefusal(headers("2"))).toBeNull();
    expect(relayApiVersionRefusal(headers())).toBeNull();
    expect(relayApiVersionRefusal(headers("3"))?.code).toBe("api_version_too_new");
  });

  it("names which side must update", () => {
    const range = { min: 2, max: 3 };
    expect(relayApiVersionRefusal(headers("1"), range)?.code).toBe("api_version_too_old");
    expect(relayApiVersionRefusal(headers(), range)?.code).toBe("api_version_too_old");
    expect(relayApiVersionRefusal(headers("2"), range)).toBeNull();
    expect(relayApiVersionRefusal(headers("3"), range)).toBeNull();
    expect(relayApiVersionRefusal(headers("4"), range)?.code).toBe("api_version_too_new");
  });

  it("refuses a value that is not one positive integer", () => {
    for (const value of ["", "0", "01", "1.0", "-1", "one", "1, 2", "1".repeat(10)]) {
      const refusal = relayApiVersionRefusal(headers(value));
      expect(refusal?.code, value).toBe("bad_request");
      expect(refusal?.statusCode, value).toBe(400);
    }
  });

  it("refuses version 1 on the engine's routes at engine minimum 2, and serves version 2 there", () => {
    for (const path of ENGINE_PATHS) {
      expect(refusalCode(path, 2, "1"), path).toBe("api_version_too_old");
      expect(refusalCode(path, 2), path).toBe("api_version_too_old");
      expect(refusalCode(path, 2, "2"), path).toBeNull();
    }
  });

  it("serves version 1 on the engine's routes while the engine minimum is 1", () => {
    for (const path of ENGINE_PATHS) {
      expect(refusalCode(path, 1, "1"), path).toBeNull();
      expect(refusalCode(path, 1), path).toBeNull();
    }
  });

  it("serves phones, share sockets, the hosted feed and unknown paths with no header at engine minimum 2", () => {
    for (const path of [
      "/sync/account/sessions",
      "/sync/live/link?ticket=t",
      "/sync/ws-a/hosted/log",
      "/sync/ws-a/presence",
      "/nowhere",
    ]) {
      expect(refusalCode(path, 2), path).toBeNull();
    }
  });

  it("leaves an automation-replica bearer to the replica handler below the engine minimum", () => {
    const replica = `Bearer ${AUTOMATION_REPLICA_BEARER_PREFIX}${"a".repeat(43)}`;
    expect(refusalCode("/sync/ws-a/log", 2, "1", replica)).toBeNull();
    expect(refusalCode("/sync/ws-a/log", 2, undefined, replica)).toBeNull();
    for (const authorization of [undefined, "Bearer test:owner", "Bearer dohc-service-v1.x"]) {
      expect(refusalCode("/sync/ws-a/log", 2, "1", authorization), authorization).toBe(
        "api_version_too_old",
      );
    }
  });

  it("reads the engine minimum from 1 up to the newest version it serves", () => {
    expect(engineApiMinimum({})).toBe(1);
    expect(engineApiMinimum({ [ENGINE_API_MIN_SETTING]: "1" })).toBe(1);
    expect(engineApiMinimum({ [ENGINE_API_MIN_SETTING]: "2" })).toBe(2);
    for (const value of ["", "0", "3", "02", "2.0", " 2", "two"]) {
      expect(engineApiMinimum({ [ENGINE_API_MIN_SETTING]: value }), value).toBeNull();
    }
  });
});
