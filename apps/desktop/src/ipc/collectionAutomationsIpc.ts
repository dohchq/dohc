import { createHash } from "node:crypto";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { writeAutomationsFile } from "@dohc/workspace-contracts/automations";
import { serializeAutomationSave, SHARED_AUTOMATION_HISTORY_REASON } from "@dohc/workspace-contracts/automation-controls";
import type { createAutomationControls } from "../workspaces/automationControls";
import { parseCollectionAutomationId } from "@dohc/automation-executor/automation-plan";
import { isNormalizedRelativePath } from "@dohc/workspace-contracts/collection-values";
import {
  AutomationShareImpactPayload,
  DismissAutomationStopsPayload,
  FindDatasetCollectionPayload,
  FindAutomationCollectionPayload,
  CheckCollectionAutomationPayload,
  ConfirmCollectionAutomationStepPayload,
  ListAutomationGroupsPayload,
  ListAutomationPeoplePayload,
  ListAutomationTargetsPayload,
  ListAutomationHoldsPayload,
  ListServerAutomationHoldsPayload,
  ListServerAutomationRunsPayload,
  ResetAutomationHoldsPayload,
  RevealAutomationHoldsPayload,
  GetCollectionAutomationRunPayload,
  ListCollectionAutomationRunsPayload,
  ListCollectionAutomationsPayload,
  ListCollectionFieldMarksPayload,
  RetryCollectionAutomationPayload,
  UndoCollectionAutomationRunPayload,
  WriteCollectionAutomationsPayload,
  SwitchCollectionAutomationPayload, ResolveAutomationControlsPayload,
  type ResolveAutomationControlsResult,
  type AutomationShareImpactResult,
  type CheckCollectionAutomationResult,
  type FindDatasetCollectionResult,
  type FindAutomationCollectionResult,
  type ConfirmCollectionAutomationStepResult,
  type ListAutomationGroupsResult,
  type ListAutomationPeopleResult,
  type ListAutomationTargetsResult,
  type DeleteWorkspacePathPayload,
  type ListAutomationHoldsResult,
  type ListServerAutomationHoldsResult,
  type ListServerAutomationRunsResult,
  type ResetAutomationHoldsResult,
  type CreateWorkspaceFilePayload,
  type GetCollectionAutomationRunResult,
  type ListCollectionAutomationRunsResult,
  type ListCollectionAutomationsResult,
  type ListCollectionFieldMarksResult,
  type RetryCollectionAutomationResult,
  type UndoCollectionAutomationRunResult,
  type WriteCollectionAutomationsResult,
  type WriteWorkspaceTextPayload,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { formulaProblems } from "@dohc/automation-executor/automation-plan";
import { AUTOMATIONS_FILE_NAME, type CollectionAutomations } from "@dohc/automation-executor/collection-automations";
import type { ServerRuns } from "../automations/serverRuns";

// The ⚡ panel's view of a Collection's automations. Main parses, checks,
// and writes automations.yaml, so the renderer never loads the file contract
// and its parser. Writes go through the same file mutations as the editor,
// so a conflict, a shared view, and file history behave as they do for any
// other save. The owner's self-hosted server keeps the runs and holds it
// made; main reads them and acts on them through the relay.

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
  controls?(operation: Operation): ReturnType<typeof createAutomationControls>;
  readText(rootPath: string, relativePath: string): Promise<{ text: string; truncated: boolean; contentHash: string | null } | null>;
  createFile(event: Event, payload: CreateWorkspaceFilePayload): Promise<unknown>;
  writeText(event: Event, payload: WriteWorkspaceTextPayload): Promise<{ status: "written"; contentHash: string } | { status: "conflict" }>;
  /** Shows a file in the system's file manager. */
  showItemInFolder(path: string): void;
  /** A person's delete: the OS trash, or the workspace's .dohc/local/trash. */
  deletePath(event: Event, payload: DeleteWorkspacePathPayload): Promise<unknown>;
  /** The window that runs a failed press again hears how the run settles. */
  watchPress(workspaceId: string, claimId: string, sender: Sender): void;
  /** The owner's self-hosted server's runs and holds. */
  serverRuns: ServerRuns;
  /** Whether a request failed because the relay could not be reached, as offline. */
  relayUnreachable(error: unknown): boolean;
}): void {
  const { serverRuns } = dependencies;
  // Offline, the server's lists have nothing to show; a relay that answered
  // with a failure is reported.
  const unlessOffline = <T>(fallback: T) => (error: unknown): T => {
    if (dependencies.relayUnreachable(error)) return fallback;
    throw error;
  };
  const { registerHandler, assertTrustedSender, withRendererWorkspaceOperation } = dependencies;
  const stale = "Automations stopped loading because this window changed workspaces.";

  function assertCollectionPath(path: string, shared = false): void {
    if (!isNormalizedRelativePath(path) || (!shared && isSharedWithMePath(path))) {
      throw new Error(`"${path}" is not a Collection in this workspace.`);
    }
  }

  registerHandler(CHANNELS.listCollectionAutomations, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListCollectionAutomationsPayload.parse(payload);
    assertCollectionPath(input.collectionPath, true);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<ListCollectionAutomationsResult> =>
      dependencies.sharedViewOf(input.workspaceId) || isSharedWithMePath(input.collectionPath)
        ? dependencies.controls ? { status: "shared", definitions: await dependencies.controls(operation).list(input.collectionPath) } : { status: "unavailable" }
        : await operation.state.collectionAutomations.automationsIn(input.collectionPath));
  });

  registerHandler(CHANNELS.switchCollectionAutomation, async (event, payload) => {
    assertTrustedSender(event);
    const { workspaceId, collectionPath, ...input } = SwitchCollectionAutomationPayload.parse(payload);
    assertCollectionPath(collectionPath, true);
    if (!dependencies.sharedViewOf(workspaceId) && !isSharedWithMePath(collectionPath)) {
      return { status: "unavailable", reason: "Use the Collection's automation editor to change its definition." };
    }
    return withRendererWorkspaceOperation(event.sender, workspaceId, stale, async operation =>
      dependencies.controls ? dependencies.controls(operation).switch(collectionPath, input)
        : { status: "unavailable", reason: "Automation switches are unavailable." });
  });

  registerHandler(CHANNELS.resolveAutomationControls, async (event, payload) => {
    assertTrustedSender(event);
    const input = ResolveAutomationControlsPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<ResolveAutomationControlsResult> => {
      const parsed = parseCollectionAutomationId(input.automationId);
      if (!parsed || !input.path.endsWith("/automations.yaml") || !dependencies.controls) return { status: "missing" };
      const collectionPath = input.path.slice(0, -"/automations.yaml".length);
      assertCollectionPath(collectionPath, true);
      const listed = await dependencies.controls(operation).list(collectionPath);
      if (listed.file.status !== "read" || !listed.file.entries.some(entry => entry.status === "valid"
        ? entry.automation.id === parsed.id : entry.id === parsed.id)) return { status: "missing" };
      return { status: "found", collectionPath, automation: parsed.id };
    });
  });

  registerHandler(CHANNELS.listCollectionAutomationRuns, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListCollectionAutomationRunsPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<ListCollectionAutomationRunsResult> =>
      dependencies.sharedViewOf(input.workspaceId)
        ? { status: "unavailable", reason: SHARED_AUTOMATION_HISTORY_REASON }
        : { status: "listed", ...await operation.state.collectionAutomations.runs(input.automationId, input.before) });
  });

  registerHandler(CHANNELS.getCollectionAutomationRun, async (event, payload) => {
    assertTrustedSender(event);
    const input = GetCollectionAutomationRunPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<GetCollectionAutomationRunResult> => {
      if (dependencies.sharedViewOf(input.workspaceId)) return { status: "unavailable", reason: SHARED_AUTOMATION_HISTORY_REASON };
      const run = input.onServer
        ? await serverRuns.get(input.workspaceId, input.automationId, input.claimId)
        : await operation.state.collectionAutomations.listedRun(input.automationId, input.claimId);
      return run === null ? { status: "missing" } : { status: "found", run };
    });
  });

  registerHandler(CHANNELS.listServerAutomationRuns, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListServerAutomationRunsPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (): Promise<ListServerAutomationRunsResult> =>
      (dependencies.sharedViewOf(input.workspaceId)
        ? null
        : await serverRuns.runs(input.workspaceId, input.automationId, input.before).catch(unlessOffline(null))) ?? { runs: null, next: null,
          ...(dependencies.sharedViewOf(input.workspaceId) ? { reason: SHARED_AUTOMATION_HISTORY_REASON } : {}) });
  });

  // Try again. The executor wakes its drain and the failure notices after
  // the engine queues the claim. Only the person who pressed a button, or
  // the workspace's owner, runs a press again. A server run runs again on
  // the server, which the relay lets only the owner ask.
  registerHandler(CHANNELS.retryCollectionAutomation, async (event, payload) => {
    assertTrustedSender(event);
    const { onServer, ...input } = RetryCollectionAutomationPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<RetryCollectionAutomationResult> =>
      onServer
        ? await serverRuns.retry(input.workspaceId, { automationId: input.automationId, claimId: input.claimId, startOver: input.startOver })
        : await operation.state.collectionAutomations.retry(input, (claimId) => dependencies.watchPress(input.workspaceId, claimId, event.sender)));
  });

  // Undo for a finished run, as the person who clicked it. Records a run
  // added to a document Collection go through the same delete as the
  // Explorer's; records added to a dataset, through an approved delete once
  // the person confirms the preview.
  registerHandler(CHANNELS.undoCollectionAutomationRun, async (event, payload) => {
    assertTrustedSender(event);
    const { onServer, ...input } = UndoCollectionAutomationRunPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<UndoCollectionAutomationRunResult> =>
      onServer
        ? await serverRuns.undo(input.workspaceId, { automationId: input.automationId, claimId: input.claimId, deletes: input.deletes })
        : await operation.state.collectionAutomations.undo(input, async (relativePath) => {
          await dependencies.deletePath(event, { workspaceId: input.workspaceId, relativePath });
        }));
  });

  registerHandler(CHANNELS.listAutomationGroups, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListAutomationGroupsPayload.parse(payload);
    assertCollectionPath(input.collectionPath);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<ListAutomationGroupsResult> =>
      dependencies.sharedViewOf(input.workspaceId)
        ? { status: "unavailable" }
        : { groups: await operation.state.collectionAutomations.groupsFor(input.collectionPath) });
  });

  registerHandler(CHANNELS.listAutomationPeople, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListAutomationPeoplePayload.parse(payload);
    assertCollectionPath(input.collectionPath);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<ListAutomationPeopleResult> =>
      dependencies.sharedViewOf(input.workspaceId)
        ? { status: "unavailable" }
        : await operation.state.collectionAutomations.peopleFor(input.collectionPath));
  });

  registerHandler(CHANNELS.listAutomationTargets, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListAutomationTargetsPayload.parse(payload);
    assertCollectionPath(input.collectionPath);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<ListAutomationTargetsResult> =>
      dependencies.sharedViewOf(input.workspaceId)
        ? { status: "unavailable" }
        : { collections: await operation.state.collectionAutomations.targetsFor(input.collectionPath) });
  });

  // The builder's check, the same one a save makes: the writer reads the
  // automation back through the file contract. It also says why the draft
  // would not run, from what the executor has indexed for its Collection,
  // and writes nothing. It answers only the window that has the workspace
  // open, like every other automations call.
  registerHandler(CHANNELS.checkCollectionAutomation, async (event, payload) => {
    assertTrustedSender(event);
    const input = CheckCollectionAutomationPayload.parse(payload);
    assertCollectionPath(input.collectionPath);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<CheckCollectionAutomationResult> => {
      let diagnostics: CheckCollectionAutomationResult["diagnostics"];
      try {
        const written = writeAutomationsFile([{ status: "valid", automation: input.automation }]);
        diagnostics = written.status === "refused" ? written.diagnostics : [];
      } catch {
        return { diagnostics: [{ code: "changed-on-reread", path: "/automations/0" }], formulaProblems: [], findProblems: [], cannotRun: null, missingFiles: [] };
      }
      // Whether it would run needs a readable automation, and says nothing in a shared view, whose automations run elsewhere.
      // A status dohc cannot give, as before the executor opens, leaves the syntax and file checks standing.
      const cannotRun = diagnostics.length > 0 || dependencies.sharedViewOf(input.workspaceId)
        ? null
        : await operation.state.collectionAutomations.draftCannotRun(input.collectionPath, input.automation).catch(() => null);
      // A code file's path passed the file contract's relative-path check; main only looks for it, as a run would.
      const missingFiles = dependencies.sharedViewOf(input.workspaceId)
        ? []
        : await operation.state.collectionAutomations.missingCodeFiles(input.collectionPath, input.automation).catch(() => []);
      // Each Find read as a run reads it, by the planner's rule for its Collection.
      const findProblems = dependencies.sharedViewOf(input.workspaceId)
        ? []
        : await operation.state.collectionAutomations.draftFindProblems(input.collectionPath, input.automation).catch(() => []);
      return { diagnostics, formulaProblems: formulaProblems(input.automation), findProblems, cannotRun, missingFiles };
    });
  });

  registerHandler(CHANNELS.listAutomationHolds, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListAutomationHoldsPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<ListAutomationHoldsResult> => {
        if (dependencies.sharedViewOf(input.workspaceId)) return { holds: [], stops: [], unreadable: false, unprovenPaths: [] };
        const executor = operation.state.collectionAutomations;
        if (input.retryPath !== undefined) {
          assertCollectionPath(input.retryPath);
          executor.handlePulledPaths([`${input.retryPath}/${AUTOMATIONS_FILE_NAME}`]);
          await executor.automationsIn(input.retryPath);
        }
        return executor.holdState();
      });
  });

  registerHandler(CHANNELS.listServerAutomationHolds, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListServerAutomationHoldsPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (): Promise<ListServerAutomationHoldsResult> =>
      ({ holds: dependencies.sharedViewOf(input.workspaceId) ? [] : await serverRuns.holds(input.workspaceId).catch(unlessOffline([])) }));
  });

  // After the saved verdicts could not be read: hold every step the roster
  // allows now, so each asks for Allow again.
  registerHandler(CHANNELS.resetAutomationHolds, async (event, payload) => {
    assertTrustedSender(event);
    const input = ResetAutomationHoldsPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<ResetAutomationHoldsResult> =>
      ({ status: await operation.state.collectionAutomations.resetHolds() }));
  });

  registerHandler(CHANNELS.revealAutomationHolds, async (event, payload) => {
    assertTrustedSender(event);
    const input = RevealAutomationHoldsPayload.parse(payload);
    await withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation) => {
      dependencies.showItemInFolder(await operation.state.collectionAutomations.reachVerdictsPath());
    });
  });

  registerHandler(CHANNELS.dismissAutomationStops, async (event, payload) => {
    assertTrustedSender(event);
    const input = DismissAutomationStopsPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<void> => {
      if (!dependencies.sharedViewOf(input.workspaceId)) await operation.state.collectionAutomations.dismissStops(input.stops);
    });
  });

  // Asked by the share dialog before it makes a share. Only the owner's
  // computer makes shares, so a shared view stops nothing.
  registerHandler(CHANNELS.automationShareImpact, async (event, payload) => {
    assertTrustedSender(event);
    const input = AutomationShareImpactPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<AutomationShareImpactResult> =>
      ({
        stops: dependencies.sharedViewOf(input.workspaceId)
          ? []
          : await operation.state.collectionAutomations.shareImpact({
              paths: input.paths, versionId: null, access: input.access, recipientEmail: input.recipientEmail,
            }),
      }));
  });

  // A shared view holds no executor, so it has no marks: the owner's
  // computer runs its automations.
  registerHandler(CHANNELS.listCollectionFieldMarks, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListCollectionFieldMarksPayload.parse(payload);
    if ("collectionPath" in input) assertCollectionPath(input.collectionPath, true);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<ListCollectionFieldMarksResult> => {
      if (dependencies.sharedViewOf(input.workspaceId) || ("collectionPath" in input && isSharedWithMePath(input.collectionPath))) return { marks: [] };
      const automations = operation.state.collectionAutomations;
      return {
        marks: "datasetId" in input
          ? await automations.datasetFieldMarks(input.datasetId, input.table)
          : await automations.fieldMarks(input.collectionPath),
      };
    });
  });

  registerHandler(CHANNELS.findDatasetCollection, async (event, payload) => {
    assertTrustedSender(event);
    const input = FindDatasetCollectionPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<FindDatasetCollectionResult> =>
      dependencies.sharedViewOf(input.workspaceId)
        ? { status: "unavailable" }
        : await operation.state.collectionAutomations.datasetCollection(input.datasetId));
  });

  registerHandler(CHANNELS.findAutomationCollection, async (event, payload) => {
    assertTrustedSender(event);
    const input = FindAutomationCollectionPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<FindAutomationCollectionResult> => {
      if (dependencies.sharedViewOf(input.workspaceId)) return { status: "unavailable" };
      const found = await operation.state.collectionAutomations.whereIs(input.automationId);
      return found === null ? { status: "missing" } : { status: "found", collectionPath: found };
    });
  });

  registerHandler(CHANNELS.confirmCollectionAutomationStep, async (event, payload) => {
    assertTrustedSender(event);
    const { onServer, workspaceId, ...input } = ConfirmCollectionAutomationStepPayload.parse(payload);
    return withRendererWorkspaceOperation(event.sender, workspaceId, stale, async (operation): Promise<ConfirmCollectionAutomationStepResult> =>
      ({ status: onServer ? await serverRuns.allow(workspaceId, input) : await operation.state.collectionAutomations.confirmReach(input) }));
  });

  // Saves the panel's automations over the file it read. Each automation
  // must read back from the written text as exactly itself, so anything the
  // file contract refuses is refused here with its diagnostics. The writer
  // drops comments and hand formatting, so a file it would lay out
  // differently is rewritten only once the person agrees.
  registerHandler(CHANNELS.writeCollectionAutomations, async (event, payload) => {
    assertTrustedSender(event);
    const input = WriteCollectionAutomationsPayload.parse(payload);
    assertCollectionPath(input.collectionPath);
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<WriteCollectionAutomationsResult> => {
      if (dependencies.sharedViewOf(input.workspaceId)) return { status: "unavailable" };
      const relativePath = `${input.collectionPath}/${AUTOMATIONS_FILE_NAME}`;
      const current = await dependencies.readText(operation.workspace.rootPath, relativePath);
      if ((current?.contentHash ?? null) !== input.expectedContentHash) return { status: "conflict" };
      const written = await serializeAutomationSave({ current, expectedContentHash: input.expectedContentHash,
        reformat: input.reformat, automations: input.automations,
        pinOperations: (automations, saved) => operation.state.collectionAutomations.pinOperations(input.collectionPath, automations, saved),
      });
      if (written.status !== "prepared") return written;
      // The index reads the new file before the panel lists it again.
      const reindex = () => operation.state.collectionAutomations.handleWatcherEvents([{ operation: "update", path: relativePath }]);
      if (current === null) {
        await dependencies.createFile(event, { workspaceId: input.workspaceId, relativePath, initialText: written.text });
        reindex();
        return { status: "written", contentHash: createHash("sha256").update(written.text).digest("hex") };
      }
      const result = await dependencies.writeText(event, {
        workspaceId: input.workspaceId,
        relativePath,
        text: written.text,
        expectedContentHash: current.contentHash!,
      });
      if (result.status !== "written") return { status: "conflict" };
      reindex();
      return { status: "written", contentHash: result.contentHash };
    });
  });
}
