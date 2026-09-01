import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createPresencePollRegistry } from "./collab/presencePollRegistry";

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

function guardedRelayResultBoundary(handler: string): {
  assignedAwaitAt: number;
  awaitEndAt: number;
  currentAfterAwaitAt: number;
} {
  const assignedAwait = /^(?<indent>[ \t]*)const [A-Za-z_$][A-Za-z0-9_$]* = await awaitCredentialGeneration\(\{/mu.exec(
    handler,
  );
  const indent = assignedAwait?.groups?.indent;
  if (!assignedAwait || indent === undefined) {
    throw new Error("Missing assigned credential-generation operation");
  }
  const awaitEndToken = `\n${indent}});`;
  const currentToken = `\n${indent}operation.assertCurrent();`;
  const currentAfterAwaitAt = handler.indexOf(
    currentToken,
    assignedAwait.index + assignedAwait[0].length,
  );
  if (currentAfterAwaitAt < 0) {
    throw new Error("Missing currentness assertion after credential generation");
  }
  const awaitEndAt = handler.lastIndexOf(awaitEndToken, currentAfterAwaitAt);
  if (awaitEndAt < assignedAwait.index) {
    throw new Error("Missing assigned credential-generation boundary");
  }
  if (
    handler.slice(awaitEndAt + awaitEndToken.length, currentAfterAwaitAt).trim()
  ) {
    throw new Error("Currentness assertion does not follow credential generation");
  }
  return {
    assignedAwaitAt: assignedAwait.index,
    awaitEndAt,
    currentAfterAwaitAt,
  };
}

const newOwnerDiscussionChannels = [
  "listRelayShareDiscussion",
  "pollRelayShareDiscussionActivity",
  "appendRelayShareDiscussion",
  "deleteRelayShareDiscussionMessage",
  "blockRelayShareDiscussionPrincipal",
  "unblockRelayShareDiscussionPrincipal",
  "pauseRelayShareDiscussion",
  "resumeRelayShareDiscussion",
  "promoteRelayShareGrant",
  "revokeRelayShareGrant",
] as const;

const ownerShareChannels = [
  "createRelayShareLink",
  "addRelayShareLink",
  "listRelayShareLinks",
  "retuneRelayShareLink",
  "rotateRelayShareLink",
  "revokeRelayShareLink",
  ...newOwnerDiscussionChannels,
] as const;

describe("main-process owner relay share authorization", () => {
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
    for (const channel of ownerShareChannels) {
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

  it("bounds every owner share request through the shared relay helper", () => {
    for (const channel of ownerShareChannels) {
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
    expect(helper).toContain("normalizeServerUrl(credentials.relayUrl)");
    expect(helper).not.toContain("const response = await fetch(");
  });

  it("refuses shared-view owner operations before credentials or a relay request", () => {
    for (const channel of [
      "createRelayShareLink",
      "addRelayShareLink",
      "retuneRelayShareLink",
      ...newOwnerDiscussionChannels,
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
    for (const channel of [
      "retuneRelayShareLink",
      "rotateRelayShareLink",
      "revokeRelayShareLink",
      "deleteRelayShareDiscussionMessage",
      "blockRelayShareDiscussionPrincipal",
      "unblockRelayShareDiscussionPrincipal",
      "pauseRelayShareDiscussion",
      "resumeRelayShareDiscussion",
      "promoteRelayShareGrant",
      "revokeRelayShareGrant",
    ]) {
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
    expect(retune).toContain("workspaceId: operation.workspace.workspaceId");
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
    expect(retune).toContain("workspaceId: operation.workspace.workspaceId");
    expect(retune).not.toContain("workspaceId: input.workspaceId");
    expect(retune).not.toContain("ownerUserId");
  });

  it("forwards only the bounded parsed inventory cursors", () => {
    const handler = handlerSource("listRelayShareLinks");
    expect(handler).toContain("input.cursor");
    expect(handler).toContain('query.set("cursor", input.cursor)');
    expect(handler).toContain("input.independentGrantCursor");
    expect(handler).toContain(
      '"independentGrantCursor",\n                input.independentGrantCursor',
    );
    expect(handler).not.toContain("payload.cursor");
    expect(handler).not.toContain("payload.independentGrantCursor");
  });

  it("uses only the finalized owner discussion routes and bodies", () => {
    const list = handlerSource("listRelayShareDiscussion");
    expect(list).toContain(
      "/sync/shares/${encodeURIComponent(input.shareId)}/discussion",
    );
    expect(list).toContain("input.cursor");
    expect(list).toContain(
      "workspaceId=${encodeURIComponent(operation.workspace.workspaceId)}",
    );
    expect(
      list.match(
        /workspaceId=\$\{encodeURIComponent\(operation\.workspace\.workspaceId\)\}/gu,
      ),
    ).toHaveLength(1);
    expect(list).not.toContain(
      "workspaceId=${encodeURIComponent(input.workspaceId)}",
    );
    expect(list).toContain("&direction=${input.direction}");
    expect(list).toContain("encodeURIComponent(input.cursor)");
    expect(list).not.toContain("payload.cursor");
    expect(list).not.toContain("limit=");
    expect(list).not.toContain('method: "POST"');
    expect(list).not.toContain("JSON.stringify");

    const activity = handlerSource("pollRelayShareDiscussionActivity");
    expect(activity).toContain(
      "/sync/shares/${encodeURIComponent(input.shareId)}/discussion/activity",
    );
    for (const field of ["input.since", "input.hold", "input.limit"]) {
      expect(activity).toContain(field);
    }
    expect(activity).toContain(
      "workspaceId=${encodeURIComponent(operation.workspace.workspaceId)}",
    );
    expect(
      activity.match(
        /workspaceId=\$\{encodeURIComponent\(operation\.workspace\.workspaceId\)\}/gu,
      ),
    ).toHaveLength(1);
    expect(activity).not.toContain(
      "workspaceId=${encodeURIComponent(input.workspaceId)}",
    );
    expect(activity).not.toContain("payload.since");
    expect(activity).not.toContain('method: "POST"');
    expect(activity).not.toContain("body: JSON.stringify");

    const append = handlerSource("appendRelayShareDiscussion");
    expect(append).toContain(
      "/sync/shares/${encodeURIComponent(input.shareId)}/discussion",
    );
    expect(append).toContain('method: "POST"');
    expect(append).toContain("workspaceId: operation.workspace.workspaceId");
    expect(
      append.match(/workspaceId: operation\.workspace\.workspaceId/gu),
    ).toHaveLength(1);
    expect(append).not.toContain("workspaceId: input.workspaceId");
    expect(append).toContain(
      "body: input.body",
    );
    expect(append).toContain("idempotencyKey: input.idempotencyKey");
    for (const forbidden of [
      "actorUserId",
      "authorUserId",
      "displayName",
      "principalUserId",
      "profile",
      "capability",
    ]) {
      expect(append).not.toContain(forbidden);
    }

    const moderation = {
      deleteRelayShareDiscussionMessage: [
        'action: "delete"',
        "messageId: input.messageId",
      ],
      blockRelayShareDiscussionPrincipal: [
        'action: "block"',
        "principalId: input.principalId",
      ],
      unblockRelayShareDiscussionPrincipal: [
        'action: "unblock"',
        "principalId: input.principalId",
      ],
      pauseRelayShareDiscussion: ['action: "pause"'],
      resumeRelayShareDiscussion: ['action: "resume"'],
    } as const;
    for (const [channel, actionFields] of Object.entries(moderation)) {
      const handler = handlerSource(channel);
      expect(handler, channel).toContain(
        "/sync/shares/${encodeURIComponent(input.shareId)}/discussion/moderation",
      );
      expect(handler, channel).toContain('method: "POST"');
      expect(handler, channel).toContain(
        "workspaceId: operation.workspace.workspaceId",
      );
      for (const field of actionFields) expect(handler, channel).toContain(field);
      expect(handler, channel).not.toContain("workspaceId: input.workspaceId");
      expect(handler, channel).not.toContain("actorUserId");
    }
  });

  it("uses exact promotion expectations and workspace-bound named revoke", () => {
    const promote = handlerSource("promoteRelayShareGrant");
    expect(promote).toContain(
      "/sync/shares/${encodeURIComponent(input.shareId)}/grants/${encodeURIComponent(input.grantId)}/promote",
    );
    expect(promote).toContain('method: "POST"');
    expect(promote).toContain("expectedParentGrantId: input.expectedParentGrantId");
    expect(promote).toContain(
      "expectedParentGeneration: input.expectedParentGeneration",
    );
    expect(promote).toContain("workspaceId: operation.workspace.workspaceId");
    expect(promote).not.toContain("expectedDependentGrantIds");
    expect(promote).not.toContain("recipientUserId");

    const revoke = handlerSource("revokeRelayShareGrant");
    expect(revoke).toContain(
      "/sync/shares/${encodeURIComponent(input.shareId)}/grants/${encodeURIComponent(input.grantId)}/revoke",
    );
    expect(revoke).toContain('method: "POST"');
    expect(revoke).toContain("JSON.stringify");
    expect(revoke).toContain("workspaceId: operation.workspace.workspaceId");
    expect(revoke).not.toContain("expectedDependentGrantIds");
    expect(revoke).not.toContain("recipientUserId");
  });

  it("pins workspace currency and credential generation around every relay call", () => {
    for (const channel of ownerShareChannels) {
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
      listRelayShareDiscussion: "RelayShareDiscussionPageResponse.safeParse(",
      pollRelayShareDiscussionActivity:
        "RelayShareDiscussionActivityResponse.safeParse(",
      appendRelayShareDiscussion: "RelayShareDiscussionAppendResponse.safeParse(",
      deleteRelayShareDiscussionMessage:
        "RelayShareDiscussionDeleteResponse.safeParse(",
      blockRelayShareDiscussionPrincipal:
        "RelayShareDiscussionBlockResponse.safeParse(",
      unblockRelayShareDiscussionPrincipal:
        "RelayShareDiscussionBlockResponse.safeParse(",
      pauseRelayShareDiscussion: "RelayShareDiscussionPauseResponse.safeParse(",
      resumeRelayShareDiscussion: "RelayShareDiscussionPauseResponse.safeParse(",
      promoteRelayShareGrant: "RelayShareGrantPromotionResponse.safeParse(",
      revokeRelayShareGrant: "RelayShareGrantRevokeResponse.safeParse(",
    } as const;
    for (const [channel, parse] of Object.entries(schemas)) {
      expect(handlerSource(channel), channel).toContain(parse);
    }
    const retune = handlerSource("retuneRelayShareLink");
    expect(retune).toContain("RelayShareLinkRetuneWidenResponse.safeParse(");
    expect(retune).toContain("RelayShareLinkRetuneNarrowResponse.safeParse(");
  });

  it("parses renderer input before entering any new owner operation", () => {
    const schemas = {
      listRelayShareDiscussion: "ListRelayShareDiscussionPayload.parse(payload)",
      pollRelayShareDiscussionActivity:
        "PollRelayShareDiscussionActivityPayload.parse(payload)",
      appendRelayShareDiscussion: "AppendRelayShareDiscussionPayload.parse(payload)",
      deleteRelayShareDiscussionMessage:
        "DeleteRelayShareDiscussionMessagePayload.parse(payload)",
      blockRelayShareDiscussionPrincipal:
        "BlockRelayShareDiscussionPrincipalPayload.parse(payload)",
      unblockRelayShareDiscussionPrincipal:
        "UnblockRelayShareDiscussionPrincipalPayload.parse(payload)",
      pauseRelayShareDiscussion: "PauseRelayShareDiscussionPayload.parse(payload)",
      resumeRelayShareDiscussion: "ResumeRelayShareDiscussionPayload.parse(payload)",
      promoteRelayShareGrant: "PromoteRelayShareGrantPayload.parse(payload)",
      revokeRelayShareGrant: "RevokeRelayShareGrantPayload.parse(payload)",
    } as const;
    for (const [channel, parse] of Object.entries(schemas)) {
      const handler = handlerSource(channel);
      expect(handler, channel).toContain(parse);
      expect(handler.indexOf(parse), channel).toBeLessThan(
        handler.indexOf("withRendererWorkspaceOperation("),
      );
    }
  });

  it("checks currentness after every guarded relay result resolves", () => {
    for (const channel of [
      "addRelayShareLink",
      "retuneRelayShareLink",
      ...newOwnerDiscussionChannels,
    ]) {
      const handler = handlerSource(channel);
      const boundary = guardedRelayResultBoundary(handler);
      const relayAt = handler.indexOf(
        "relayShareJsonWithCredentials",
        boundary.assignedAwaitAt,
      );
      const successParse = handler.indexOf("safeParse(", boundary.assignedAwaitAt);
      expect(relayAt, channel).toBeGreaterThan(-1);
      expect(boundary.awaitEndAt, channel).toBeGreaterThan(relayAt);
      expect(boundary.currentAfterAwaitAt, channel).toBeGreaterThan(
        boundary.awaitEndAt,
      );
      expect(successParse, channel).toBeGreaterThan(boundary.currentAfterAwaitAt);
    }

    const handlerWithNestedCloseToken = handlerSource("addRelayShareLink").replace(
      "relayShareJsonWithCredentials<unknown>(",
      "relayShareJsonWithCredentials<unknown>(\n              /* nested }); token */",
    );
    const nestedBoundary = guardedRelayResultBoundary(handlerWithNestedCloseToken);
    const nestedRelayAt = handlerWithNestedCloseToken.indexOf(
      "relayShareJsonWithCredentials",
      nestedBoundary.assignedAwaitAt,
    );
    expect(
      handlerWithNestedCloseToken.indexOf("});", nestedRelayAt),
    ).toBeLessThan(nestedBoundary.awaitEndAt);
  });

  it("owns each discussion activity park by window and poll id and fences its parsed body", () => {
    expect(mainSource).toContain(
      "const relayShareDiscussionActivityPolls = createPresencePollRegistry();",
    );
    const activity = handlerSource("pollRelayShareDiscussionActivity");
    const beginAt = activity.indexOf("relayShareDiscussionActivityPolls.begin(");
    const credentialsAt = activity.indexOf("remoteForWorkspace(operation.workspace)");
    const relayAt = activity.indexOf("relayShareJsonWithCredentials<unknown>(");
    const parseAt = activity.indexOf("RelayShareDiscussionActivityResponse.safeParse(");
    const postParseWorkspaceFenceAt = activity.indexOf(
      "operation.assertCurrent();",
      parseAt,
    );
    const postParseCredentialFenceAt = activity.indexOf(
      "credentialCacheGeneration !== credentialGeneration",
      parseAt,
    );

    expect(beginAt).toBeGreaterThan(-1);
    expect(activity).toContain("event.sender.id,");
    expect(activity).toContain("input.pollId,");
    expect(activity).toContain("signal: poll.signal");
    expect(credentialsAt).toBeGreaterThan(beginAt);
    expect(relayAt).toBeGreaterThan(credentialsAt);
    expect(parseAt).toBeGreaterThan(relayAt);
    expect(postParseWorkspaceFenceAt).toBeGreaterThan(parseAt);
    expect(postParseCredentialFenceAt).toBeGreaterThan(parseAt);
    expect(activity).toContain("poll.release();");

    const cancel = handlerSource("cancelRelayShareDiscussionActivity");
    expect(cancel).toContain(
      "CancelRelayShareDiscussionActivityPayload.parse(payload)",
    );
    expect(cancel).toContain(
      "relayShareDiscussionActivityPolls.cancel(event.sender.id, input.pollId)",
    );
    expect(cancel).not.toContain("presencePollRegistry.cancel");

    const registry = createPresencePollRegistry();
    const owned = registry.begin(1, "poll-a", "share-a");
    const sibling = registry.begin(1, "poll-b", "share-b");
    expect(sibling.signal).not.toBe(owned.signal);
    registry.cancel(2, "poll-a");
    expect(owned.signal.aborted).toBe(false);
    registry.cancel(1, "poll-b");
    expect(sibling.signal.aborted).toBe(true);
    expect(owned.signal.aborted).toBe(false);
    registry.cancel(1, "poll-a");
    expect(owned.signal.aborted).toBe(true);
  });

  it("never logs or throws a minted URL", () => {
    for (const channel of ownerShareChannels) {
      const handler = handlerSource(channel);
      expect(handler, channel).not.toMatch(/console\.(?:error|warn|log)/u);
      expect(handler, channel).not.toMatch(/throw[^;]*(?:\.url|\["url"\])/u);
      expect(handler, channel).not.toMatch(
        /throw[^;]*(?:token|credential|profile|principalUserId)/u,
      );
    }
  });
});
