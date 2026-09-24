import { createHash } from "node:crypto";
import { isSharedWithMePath } from "@dohc/workspace-core";
import {
  parseAutomationsFile,
  writeAutomationsFile,
  type Automation,
} from "@dohc/workspace-contracts/automations";
import { isNormalizedRelativePath } from "@dohc/workspace-contracts/collection-values";
import {
  ConfirmCollectionAutomationStepPayload,
  ListAutomationHoldsPayload,
  ListCollectionAutomationRunsPayload,
  ListCollectionAutomationsPayload,
  RetryCollectionAutomationPayload,
  WriteCollectionAutomationsPayload,
  type ConfirmCollectionAutomationStepResult,
  type ListAutomationHoldsResult,
  type CreateWorkspaceFilePayload,
  type ListCollectionAutomationRunsResult,
  type ListCollectionAutomationsResult,
  type RetryCollectionAutomationResult,
  type WriteCollectionAutomationsResult,
  type WriteWorkspaceTextPayload,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { AUTOMATIONS_FILE_NAME, type CollectionAutomations } from "../automations/collectionAutomations";

// The ⚡ panel's view of a Collection's automations. Main parses, checks,
// and writes automations.yaml, so the renderer never loads the file contract
// and its parser. Writes go through the same file mutations as the editor,
// so a conflict, a shared view, and file history behave as they do for any
// other save.

export function registerCollectionAutomationsIpc<
  Sender,
  Event extends { sender: Sender },
  Operation extends {
    readonly workspace: { readonly workspaceId: string; readonly rootPath: string };
    readonly state: { readonly collectionAutomations: CollectionAutomations };
  },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender, workspaceId: string, message: string,
    work: (operation: Operation) => Promise<Result>,
  ): Promise<Result>;
  /** A shared view holds no executor: its automations run on the owner's computer. */
  sharedViewOf(workspaceId: string): unknown;
  readText(rootPath: string, relativePath: string): Promise<{ text: string; truncated: boolean; contentHash: string | null } | null>;
  createFile(event: Event, payload: CreateWorkspaceFilePayload): Promise<unknown>;
  writeText(event: Event, payload: WriteWorkspaceTextPayload): Promise<{ status: "written"; contentHash: string } | { status: "conflict" }>;
}): void {
  const { registerHandler, assertTrustedSender, withRendererWorkspaceOperation } = dependencies;
  const stale = "Automations stopped loading because this window changed workspaces.";

  function assertCollectionPath(path: string): void {
    if (!isNormalizedRelativePath(path) || isSharedWithMePath(path)) {
      throw new Error(`"${path}" is not a Collection in this workspace.`);
    }
  }

  registerHandler(CHANNELS.listCollectionAutomations, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListCollectionAutomationsPayload.parse(payload);
    assertCollectionPath(input.collectionPath);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<ListCollectionAutomationsResult> =>
      dependencies.sharedViewOf(input.workspaceId)
        ? { status: "unavailable" }
        : await operation.state.collectionAutomations.automationsIn(input.collectionPath));
  });

  registerHandler(CHANNELS.listCollectionAutomationRuns, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListCollectionAutomationRunsPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<ListCollectionAutomationRunsResult> =>
      ({ runs: await operation.state.collectionAutomations.runs(input.automationId) }));
  });

  // Try again. The executor wakes its drain and the failure notices after
  // the engine queues the claim.
  registerHandler(CHANNELS.retryCollectionAutomation, async (event, payload) => {
    assertTrustedSender(event);
    const input = RetryCollectionAutomationPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<RetryCollectionAutomationResult> =>
      await operation.state.collectionAutomations.retry(input));
  });

  registerHandler(CHANNELS.listAutomationHolds, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListAutomationHoldsPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<ListAutomationHoldsResult> =>
      ({ holds: dependencies.sharedViewOf(input.workspaceId) ? [] : operation.state.collectionAutomations.holds() }));
  });

  registerHandler(CHANNELS.confirmCollectionAutomationStep, async (event, payload) => {
    assertTrustedSender(event);
    const input = ConfirmCollectionAutomationStepPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<ConfirmCollectionAutomationStepResult> =>
      ({ status: await operation.state.collectionAutomations.confirmReach(input) }));
  });

  // Saves the panel's automations over the file it read. Each automation
  // must read back from the written text as exactly itself, so anything the
  // file contract refuses is refused here with its diagnostics.
  registerHandler(CHANNELS.writeCollectionAutomations, async (event, payload) => {
    assertTrustedSender(event);
    const input = WriteCollectionAutomationsPayload.parse(payload);
    assertCollectionPath(input.collectionPath);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<WriteCollectionAutomationsResult> => {
      if (dependencies.sharedViewOf(input.workspaceId)) return { status: "unavailable" };
      const relativePath = `${input.collectionPath}/${AUTOMATIONS_FILE_NAME}`;
      const current = await dependencies.readText(operation.workspace.rootPath, relativePath);
      if ((current?.contentHash ?? null) !== input.expectedContentHash) return { status: "conflict" };
      if (current) {
        const parsed = parseAutomationsFile(current.text);
        // The writer cannot keep what it could not read, so editing waits
        // until the file is fixed by hand.
        if (current.truncated || parsed.status !== "read" || parsed.entries.some((entry) => entry.status === "invalid")) {
          return { status: "unreadable" };
        }
      }
      let written: ReturnType<typeof writeAutomationsFile>;
      try {
        // The writer reads its own text back, so a shape the file contract
        // would not produce is refused rather than written.
        written = writeAutomationsFile(input.automations.map((automation) => ({
          status: "valid",
          automation: automation as unknown as Automation,
        })));
      } catch {
        return { status: "refused", diagnostics: [{ code: "changed-on-reread", path: "/automations" }] };
      }
      if (written.status === "refused") return { status: "refused", diagnostics: written.diagnostics };
      if (current === null) {
        await dependencies.createFile(event, { workspaceId: input.workspaceId, relativePath, initialText: written.text });
        return { status: "written", contentHash: createHash("sha256").update(written.text).digest("hex") };
      }
      const result = await dependencies.writeText(event, {
        workspaceId: input.workspaceId,
        relativePath,
        text: written.text,
        expectedContentHash: current.contentHash!,
      });
      return result.status === "written" ? { status: "written", contentHash: result.contentHash } : { status: "conflict" };
    });
  });
}
