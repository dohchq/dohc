import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const mainSource = readFileSync(new URL("./main.ts", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);

function handlerSource(channel: string): string {
  const marker = `CHANNELS.${channel},`;
  const markerAt = mainSource.indexOf(marker);
  if (markerAt < 0) throw new Error(`Missing IPC handler for ${channel}`);
  const start = mainSource.lastIndexOf("ipcMain.handle(", markerAt);
  if (start < 0) throw new Error(`Missing IPC handler for ${channel}`);
  const next = mainSource.indexOf("ipcMain.handle(", markerAt + marker.length);
  return mainSource.slice(start, next < 0 ? undefined : next);
}

const ownerLinkChannels = [
  "createRelayShareLink",
  "addRelayShareLink",
  "listRelayShareLinks",
  "retuneRelayShareLink",
  "rotateRelayShareLink",
  "revokeRelayShareLink",
] as const;

describe("main-process owner relay link authorization", () => {
  it("refuses a missing channel marker before searching backwards", () => {
    const channel = "definitelyAbsentRelayShareLinkHandler";
    let thrown: unknown;
    let reverseSearchCalls = -1;
    const lastIndexOf = vi.spyOn(String.prototype, "lastIndexOf");

    try {
      try {
        handlerSource(channel);
      } catch (error) {
        thrown = error;
      }
      reverseSearchCalls = lastIndexOf.mock.calls.length;
    } finally {
      lastIndexOf.mockRestore();
    }

    expect(thrown).toEqual(new Error(`Missing IPC handler for ${channel}`));
    expect(reverseSearchCalls).toBe(0);
  });

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

  it("bounds every owner link request through the shared relay helper", () => {
    for (const channel of ownerLinkChannels) {
      expect(handlerSource(channel), channel).toContain(
        "relayShareJsonWithCredentials",
      );
    }

    const helperStart = mainSource.indexOf(
      "type RelayShareRetainedDependentSetResult",
    );
    const helperEnd = mainSource.indexOf(
      "async function relayShareJson<T>",
      helperStart,
    );
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = mainSource.slice(helperStart, helperEnd);
    expect(helper).toContain(
      "relayFetchWithTimeout(RELAY_SHARE_FETCH_TIMEOUT_MS)",
    );
    expect(helper).toContain("const response = await relayShareFetch(");
    expect(helper).not.toContain("const response = await fetch(");
  });

  it("refuses shared-view link mutations before credentials or a relay request", () => {
    for (const channel of [
      "createRelayShareLink",
      "addRelayShareLink",
      "retuneRelayShareLink",
    ]) {
      const handler = handlerSource(channel);
      const operationAt = handler.indexOf("async (operation) => {");
      const guardAt =
        /if \(shareViewIsPresent\(operation\.workspace\.shareView\)\) \{\s*throw new Error\(\s*"This is a shared view — only the original workspace can be shared\.",\s*\);\s*\}/u.exec(
          handler,
        )?.index ?? -1;
      const credentialsAt = handler.indexOf(
        "remoteForWorkspace(operation.workspace)",
      );
      const relayAt = handler.indexOf("relayShareJsonWithCredentials");

      expect(operationAt, channel).toBeGreaterThan(-1);
      expect(
        guardAt,
        `${channel}: the shared-view refusal must be inside the physical workspace operation`,
      ).toBeGreaterThan(operationAt);
      expect(credentialsAt, channel).toBeGreaterThan(guardAt);
      expect(relayAt, channel).toBeGreaterThan(credentialsAt);
      expect(handler, channel).not.toMatch(
        /if\s*\(\s*operation\.workspace\.shareView\s*\)/u,
      );
    }
  });

  it("addresses workspace routes and injects share-route workspace bodies from the operation", () => {
    for (const channel of ["createRelayShareLink", "listRelayShareLinks"]) {
      expect(handlerSource(channel), channel).toContain(
        "/sync/${encodeURIComponent(operation.workspace.workspaceId)}/shares/links",
      );
    }
    const add = handlerSource("addRelayShareLink");
    expect(add).toContain(
      "/sync/${encodeURIComponent(operation.workspace.workspaceId)}/shares/${encodeURIComponent(input.shareId)}/links",
    );
    expect(add).not.toContain("/sync/${encodeURIComponent(input.workspaceId)}");
    for (const channel of ["rotateRelayShareLink", "revokeRelayShareLink"]) {
      const handler = handlerSource(channel);
      expect(handler, channel).toContain(
        "workspaceId: operation.workspace.workspaceId",
      );
      expect(handler, channel).not.toContain("workspaceId: input.workspaceId");
    }
    const retune = handlerSource("retuneRelayShareLink");
    expect(retune).toContain(
      "/sync/shares/${encodeURIComponent(input.shareId)}/links/${encodeURIComponent(input.grantId)}/retune",
    );
    expect(retune).not.toContain("workspaceId: input.workspaceId");
  });

  it("sends only the exact method and bounded link lifecycle bodies", () => {
    const create = handlerSource("createRelayShareLink");
    expect(create).toContain("method: \"POST\"");
    expect(create).toContain("access: input.access");
    expect(create).not.toContain("ownerUserId");

    const add = handlerSource("addRelayShareLink");
    expect(add).toContain("method: \"POST\"");
    expect(add).toContain("body: JSON.stringify({ access: input.access })");
    expect(add).not.toContain("paths: input.paths");
    expect(add).not.toContain("versionId: input.versionId");
    expect(add).not.toContain("ownerUserId");

    const retune = handlerSource("retuneRelayShareLink");
    expect(retune).toContain("method: \"POST\"");
    expect(retune).toContain("access: input.access");
    expect(retune).toContain(
      "expectedDependentGrantIds: input.expectedDependentGrantIds",
    );
    expect(retune).not.toContain("workspaceId: input.workspaceId");
    expect(retune).not.toContain("ownerUserId");
  });

  it("forwards only the bounded parsed inventory cursor", () => {
    const handler = handlerSource("listRelayShareLinks");
    expect(handler).toContain("input.cursor");
    expect(handler).toContain("encodeURIComponent(input.cursor)");
    expect(handler).not.toContain("payload.cursor");
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

  it("returns only typed dependent conflicts from lifecycle mutations", () => {
    for (const channel of [
      "retuneRelayShareLink",
      "rotateRelayShareLink",
      "revokeRelayShareLink",
    ]) {
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
      addRelayShareLink: "RelayShareLinkCreateResponse.safeParse(",
      listRelayShareLinks: "RelayShareLinkListResponse.safeParse(",
      rotateRelayShareLink: "RelayShareLinkRotateResponse.safeParse(",
      revokeRelayShareLink: "RelayShareLinkEndResponse.safeParse(",
    } as const;
    for (const [channel, parse] of Object.entries(schemas)) {
      expect(handlerSource(channel), channel).toContain(parse);
    }
    const retune = handlerSource("retuneRelayShareLink");
    expect(retune).toContain("RelayShareLinkRetuneWidenResponse.safeParse(");
    expect(retune).toContain("RelayShareLinkRetuneNarrowResponse.safeParse(");
  });

  it("checks currentness after a stale add or retune relay result resolves", () => {
    for (const channel of ["addRelayShareLink", "retuneRelayShareLink"]) {
      const handler = handlerSource(channel);
      const relayAt = handler.indexOf("relayShareJsonWithCredentials");
      const awaitEnd = handler.indexOf("});", relayAt);
      const currentAfterAwait = handler.indexOf(
        "operation.assertCurrent();",
        awaitEnd,
      );
      const successParse = handler.indexOf("safeParse(", currentAfterAwait);
      expect(relayAt, channel).toBeGreaterThan(-1);
      expect(currentAfterAwait, channel).toBeGreaterThan(awaitEnd);
      expect(successParse, channel).toBeGreaterThan(currentAfterAwait);
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
