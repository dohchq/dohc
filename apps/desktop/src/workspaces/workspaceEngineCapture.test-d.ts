// Compile-only contracts, enforced by the desktop typecheck.
import type { WorkspaceEngineCapture } from "./workspaceEngineCapture";
import type { CaptureVersionedTextStore } from "./workspaceEngineCaptureLiveStore";

declare const capture: WorkspaceEngineCapture;
declare const store: CaptureVersionedTextStore;
const agent = { kind: "agent", agentId: "agent" } as const;
const automation = { kind: "automation", automationId: "automation", depth: 4 } as const;

for (const author of [agent, automation]) {
  // @ts-expect-error Captured writes require the author principal.
  capture.writeAuthoredTextFile("C:/workspace/note.md", "text", author);
  capture.writeAuthoredTextFile("C:/workspace/note.md", "text", { ...author, onBehalfOf: "local" });
}

// @ts-expect-error The ambient capture author also requires a principal.
store.setCaptureAuthor?.(agent);
store.setCaptureAuthor?.({ ...agent, onBehalfOf: "local" });
store.setCaptureAuthor?.(null);
