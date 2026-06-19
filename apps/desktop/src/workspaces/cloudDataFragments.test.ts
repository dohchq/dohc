import { describe, expect, it } from "vitest";
import {
  createCloudDataFragment,
  listCloudDataFragments,
  readCloudDataFragment,
  revokeCloudDataFragment,
} from "./cloudDataFragments";

const fragment = {
  fragmentId: "fragment-1",
  sourceWorkspaceId: "ws-source",
  sourcePath: "notes/day.md",
  title: "Apple count",
  preview: "10 apples",
  contentType: "text/plain",
  createdBy: "user-1",
  createdAt: "2026-06-18T00:00:00.000Z",
  recipientEmail: "peer@dohc.test",
};

describe("desktop Cloud data fragment requests", () => {
  it("exports selected data to the workspace-api data-fragment route", async () => {
    const calls: Array<[string, RequestInit?]> = [];
    const cloudJson = async <T,>(path: string, init?: RequestInit) => {
      calls.push([path, init]);
      return { fragment } as T;
    };

    await expect(
      createCloudDataFragment(cloudJson, "remote ws/source", {
        workspaceId: "ws-local",
        sourcePath: "notes/day.md",
        body: "10 apples",
        contentType: "text/plain",
        recipientEmail: "peer@dohc.test",
      }),
    ).resolves.toEqual({ fragment });

    expect(calls).toEqual([
      [
        "/workspaces/remote%20ws%2Fsource/data-fragments",
        {
          method: "POST",
          body: JSON.stringify({
            sourcePath: "notes/day.md",
            contentType: "text/plain",
            body: "10 apples",
            recipientEmail: "peer@dohc.test",
          }),
        },
      ],
    ]);
  });

  it("lists, reads, and revokes shared Cloud fragments by stable fragment id", async () => {
    const responses: unknown[] = [
      { fragments: [fragment] },
      { fragment: { ...fragment, body: "10 apples" } },
      { ok: true, revoked: true },
    ];
    const calls: Array<[string, RequestInit?]> = [];
    const cloudJson = async <T,>(path: string, init?: RequestInit) => {
      calls.push([path, init]);
      return responses.shift() as T;
    };

    await expect(listCloudDataFragments(cloudJson)).resolves.toEqual({
      fragments: [fragment],
    });
    await expect(readCloudDataFragment(cloudJson, "fragment/1")).resolves.toEqual({
      fragment: { ...fragment, body: "10 apples" },
    });
    await expect(revokeCloudDataFragment(cloudJson, "fragment/1")).resolves.toBeUndefined();

    expect(calls).toEqual([
      ["/me/data-fragments", undefined],
      ["/data-fragments/fragment%2F1", undefined],
      ["/data-fragments/fragment%2F1", { method: "DELETE" }],
    ]);
  });
});
