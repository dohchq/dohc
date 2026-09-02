import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCollectionSchema } from "@dohc/workspace-contracts/collection-values";
import { rewriteCollectionSchema } from "./schemaWrite";

// The rewrite's whole contract: the mutation input comes from the SAME read
// that supplies expectedContentHash, so no other request can slip a stale
// schema over a newer file, and a degraded parse never reaches the write.

const bridgeMock = vi.hoisted(() => ({
  readWorkspaceText: vi.fn(),
  writeWorkspaceText: vi.fn(),
}));
vi.mock("../bridge", () => ({ bridge: () => bridgeMock }));

afterEach(() => {
  bridgeMock.readWorkspaceText.mockReset();
  bridgeMock.writeWorkspaceText.mockReset();
});

describe("rewriteCollectionSchema", () => {
  it("derives the mutation from the read snapshot and keeps its hash", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "fields:\n  Name:\n    type: text\n",
      truncated: false,
      contentHash: "hash-1",
    });
    bridgeMock.writeWorkspaceText.mockResolvedValue({
      status: "written",
      contentHash: "hash-2",
    });

    const result = await rewriteCollectionSchema({
      workspaceId: "ws-1",
      collectionPath: "projects/tasks",
      mutate: (schema) => ({
        ...schema,
        fields: [...schema.fields, { name: "Status", type: "text" }],
      }),
    });

    expect(result).toEqual({ status: "written" });
    expect(bridgeMock.writeWorkspaceText).toHaveBeenCalledOnce();
    const payload = bridgeMock.writeWorkspaceText.mock.calls[0]?.[0] as {
      workspaceId: string;
      relativePath: string;
      text: string;
      expectedContentHash: string;
    };
    expect(payload.workspaceId).toBe("ws-1");
    expect(payload.relativePath).toBe("projects/tasks/collection.yaml");
    expect(payload.expectedContentHash).toBe("hash-1");
    const written = parseCollectionSchema(payload.text);
    expect(written.status).toBe("valid");
    expect(written.schema.fields).toEqual([
      { name: "Name", type: "text" },
      { name: "Status", type: "text" },
    ]);
  });

  it("rejects a degraded parse without writing", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "fields:\n  Name:\n    type: text\nextra: unmodeled\n",
      truncated: false,
      contentHash: "hash-1",
    });

    const result = await rewriteCollectionSchema({
      workspaceId: "ws-1",
      collectionPath: "projects/tasks",
      mutate: (schema) => schema,
    });

    expect(result.status).toBe("error");
    expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
  });

  it("reports a concurrent edit as a conflict", async () => {
    bridgeMock.readWorkspaceText.mockResolvedValue({
      text: "fields:\n  Name:\n    type: text\n",
      truncated: false,
      contentHash: "hash-1",
    });
    bridgeMock.writeWorkspaceText.mockResolvedValue({
      status: "conflict",
      currentContentHash: "hash-9",
    });

    const result = await rewriteCollectionSchema({
      workspaceId: "ws-1",
      collectionPath: "projects/tasks",
      mutate: (schema) => schema,
    });

    expect(result).toEqual({ status: "conflict" });
  });
});
