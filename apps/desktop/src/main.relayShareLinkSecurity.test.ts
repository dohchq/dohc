import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);

function handlerSource(channel: string): string {
  const marker = `CHANNELS.${channel},`;
  const markerAt = mainSource.indexOf(marker);
  const start = mainSource.lastIndexOf("ipcMain.handle(", markerAt);
  if (markerAt < 0 || start < 0) throw new Error(`Missing IPC handler for ${channel}`);
  const next = mainSource.indexOf("ipcMain.handle(", markerAt + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

const ownerLinkChannels = [
  "createRelayShareLink",
  "listRelayShareLinks",
  "rotateRelayShareLink",
  "revokeRelayShareLink",
] as const;

describe("main-process owner relay link authorization", () => {
  it("admits every request through one exact physical workspace operation", () => {
    for (const channel of ownerLinkChannels) {
      const handler = handlerSource(channel);
      expect(handler, channel).toContain("assertTrustedSender(event);");
      expect(handler, channel).toContain("withRendererWorkspaceOperation(");
      expect(handler, channel).toContain("operation.workspace");
      expect(handler, channel).toContain("remoteForWorkspace(operation.workspace)");
      expect(handler, channel).not.toContain("requireWorkspace(input.workspaceId)");
      expect(handler, channel).not.toContain("findWorkspace(input.workspaceId)");
      expect(handler, channel).not.toContain("requireEngineCapture(input.workspaceId");
    }
  });

  it("addresses workspace routes and injects share-route workspace bodies from the operation", () => {
    for (const channel of ["createRelayShareLink", "listRelayShareLinks"]) {
      expect(handlerSource(channel), channel).toContain(
        "/sync/${encodeURIComponent(operation.workspace.workspaceId)}/shares/links",
      );
    }
    for (const channel of ["rotateRelayShareLink", "revokeRelayShareLink"]) {
      const handler = handlerSource(channel);
      expect(handler, channel).toContain(
        "workspaceId: operation.workspace.workspaceId",
      );
      expect(handler, channel).not.toContain("workspaceId: input.workspaceId");
    }
  });

  it("pins workspace currency and credential generation around every relay call", () => {
    for (const channel of ownerLinkChannels) {
      const handler = handlerSource(channel);
      expect(handler, channel).toContain("awaitCredentialGeneration({");
      expect(handler, channel).toContain(
        "capturedGeneration: credentialGeneration",
      );
      expect(handler, channel).toContain(
        "currentGeneration: () => credentialCacheGeneration",
      );
      expect(handler.match(/operation\.assertCurrent\(\);/gu)?.length ?? 0, channel)
        .toBeGreaterThanOrEqual(4);
      const relayAt = handler.indexOf("relayShareJsonWithCredentials");
      expect(relayAt, channel).toBeGreaterThan(-1);
      expect(handler.lastIndexOf("operation.assertCurrent();", relayAt), channel)
        .toBeGreaterThan(-1);
      expect(handler.indexOf("operation.assertCurrent();", relayAt), channel)
        .toBeGreaterThan(relayAt);
    }
  });

  it("returns only typed dependent conflicts from reset and end", () => {
    for (const channel of ["rotateRelayShareLink", "revokeRelayShareLink"]) {
      const handler = handlerSource(channel);
      expect(handler, channel).toContain("retainDependentSetConflict: true");
      expect(handler, channel).toContain("RelayShareLinkDependentConflict.safeParse(");
      expect(handler, channel).toContain('outcome: "dependents-changed"');
      expect(handler, channel).toContain("throw new Error(relayShareErrorCopy(");
    }
  });

  it("parses every relay success before returning it over IPC", () => {
    const schemas = {
      createRelayShareLink: "RelayShareLinkCreateResponse.safeParse(",
      listRelayShareLinks: "RelayShareLinkListResponse.safeParse(",
      rotateRelayShareLink: "RelayShareLinkRotateResponse.safeParse(",
      revokeRelayShareLink: "RelayShareLinkEndResponse.safeParse(",
    } as const;
    for (const [channel, parse] of Object.entries(schemas)) {
      expect(handlerSource(channel), channel).toContain(parse);
    }
  });

  it("never logs or throws a minted URL", () => {
    for (const channel of ownerLinkChannels) {
      const handler = handlerSource(channel);
      expect(handler, channel).not.toMatch(/console\.(?:error|warn|log)/u);
      expect(handler, channel).not.toMatch(/throw[^;]*(?:\.url|\["url"\])/u);
    }
  });
});
