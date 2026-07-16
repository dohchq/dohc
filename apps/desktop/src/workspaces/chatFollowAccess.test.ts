import { describe, expect, it, vi } from "vitest";
import {
  assertChatFollowWriteAllowed,
  listChatChannelsReadOnlySafe,
  listChatFollowsReadOnlySafe,
  markPersonalFeedSeenReadOnlySafe,
} from "./chatFollowAccess";

describe("shared-view chat access", () => {
  it("lists channels without creating General in a read-only shared view", async () => {
    const seedGeneral = vi.fn(async () => undefined);
    const list = vi.fn(async () => ["shared-channel"]);

    await expect(listChatChannelsReadOnlySafe({
      readOnly: true,
      seedGeneral,
      list,
    })).resolves.toEqual(["shared-channel"]);
    expect(seedGeneral).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledOnce();
  });

  it("lists existing follows without seeding defaults in a read-only shared view", async () => {
    const seedDefaults = vi.fn(async () => undefined);
    const list = vi.fn(async () => ["existing-follow"]);

    await expect(listChatFollowsReadOnlySafe({
      readOnly: true,
      seedDefaults,
      list,
    })).resolves.toEqual(["existing-follow"]);
    expect(seedDefaults).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledOnce();
  });

  it("rejects a follow write before its mutation callback can run", () => {
    const mutation = vi.fn();
    expect(() => {
      assertChatFollowWriteAllowed({
        readOnly: true,
        reject: () => {
          throw new Error("shared view is read-only");
        },
      });
      mutation();
    }).toThrow("shared view is read-only");
    expect(mutation).not.toHaveBeenCalled();
  });

  it("silently skips the viewer-local seen cursor write in a read-only shared view", async () => {
    const mark = vi.fn(async () => undefined);
    await markPersonalFeedSeenReadOnlySafe({ readOnly: true, mark });
    expect(mark).not.toHaveBeenCalled();
  });
});
