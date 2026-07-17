import * as Y from "yjs";
import { YdocLoopbackEngine } from "@dohc/workspace-engine-client";
import { describe, expect, it, vi } from "vitest";
import { openEngineYdocProviderSessionRust } from "./ydocEngineProviderSessionRust";

describe("openEngineYdocProviderSessionRust", () => {
  it("runs the desktop wrapper end-to-end against R11b's loopback transport", async () => {
    const transport = new YdocLoopbackEngine();
    transport.seedFile({
      workspace: "workspace-handle",
      versionId: "main",
      path: "notes/rust.md",
      markdown: "seed",
      contentKind: "plaintext",
    });
    const onRemoteUpdate = vi.fn();
    const session = await openEngineYdocProviderSessionRust({
      transport,
      workspace: "workspace-handle",
      versionId: "main",
      path: "notes/rust.md",
      contentKind: "plaintext",
      onRemoteUpdate,
      scheduleSettle: () => () => {},
    });

    const rendererDoc = new Y.Doc();
    Y.applyUpdate(rendererDoc, session.initialUpdate);
    const before = Y.encodeStateVector(rendererDoc);
    rendererDoc.getText("plainText").insert(4, " via adapter");
    session.applyLocalUpdate(Y.encodeStateAsUpdate(rendererDoc, before));
    const settled = await session.settleNow({ summary: "adapter e2e" });

    expect(settled.markdown).toBe("seed via adapter");
    expect(transport.requests.map(({ method }) => method)).toEqual([
      "ydoc.open",
      "ydoc.recordUpdate",
      "ydoc.settle",
    ]);
    expect(onRemoteUpdate).not.toHaveBeenCalled();
    await session.close({ settle: false });
  });
});
