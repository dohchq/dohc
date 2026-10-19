import { describe, expect, it } from "vitest";
import { CAPABILITIES, CAPABILITY_ID_PATTERN, CAPABILITY_WAYS, RETIRED_CAPABILITY_IDS, SEPARATE_CAPABILITY_DOORS } from "./capabilities";
import issuedIds from "./capabilityIds.issued.json";

describe("capability ids", () => {
  it("uses dotted lowercase identities independent of door names", () => {
    for (const id of Object.keys(CAPABILITIES)) expect(id).toMatch(CAPABILITY_ID_PATTERN);
    for (const invalid of ["file", "File.move", "file.Move", "file-move", "file..move", "file.move.", "file/path.move"]) {
      expect(invalid).not.toMatch(CAPABILITY_ID_PATTERN);
    }
    expect(CAPABILITY_WAYS).toEqual(["control", "palette", "menu", "shortcut", "cli", "mcp", "app"]);
  });

  it("accounts for every issued id as current or retired", () => {
    // Append new ids to this ledger. Never delete an issued id.
    const current = Object.keys(CAPABILITIES);
    expect(new Set(issuedIds).size).toBe(issuedIds.length);
    for (const id of issuedIds) {
      expect(id).toMatch(CAPABILITY_ID_PATTERN);
      expect([...current, ...RETIRED_CAPABILITY_IDS]).toContain(id);
    }
    for (const id of current) expect(issuedIds).toContain(id);
  });

  it("never reuses retired ids", () => {
    for (const id of RETIRED_CAPABILITY_IDS) {
      expect(id).toMatch(CAPABILITY_ID_PATTERN);
      expect(Object.keys(CAPABILITIES)).not.toContain(id);
      expect(issuedIds).toContain(id);
    }
    expect(new Set(RETIRED_CAPABILITY_IDS).size).toBe(RETIRED_CAPABILITY_IDS.length);
  });

  it("names the app, automation executor, and share-link boundaries without offering them local rows", () => {
    expect(Object.keys(SEPARATE_CAPABILITY_DOORS)).toEqual(["app", "automationExecutor", "shareLink"]);
    for (const door of Object.values(SEPARATE_CAPABILITY_DOORS)) {
      expect(door.source).toBeTruthy();
      expect(door.reason).toBeTruthy();
    }
  });
});

it("keeps Access refresh on IPC and CLI without advertising an MCP tool", () => {
  expect(CAPABILITIES["access.refresh"].ipc.operations).toEqual(["requestAccessRefresh"]);
  expect(CAPABILITIES["access.refresh"].mcp).toMatchObject({ owner: [], view: [], comment: [], edit: [] });
  expect(CAPABILITIES["access.refresh"].mcp.reason).toContain("dohc access refresh");
});
