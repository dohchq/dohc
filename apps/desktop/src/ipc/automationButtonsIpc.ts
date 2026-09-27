import type { DatasetDescription } from "@dohc/security-contract/dataset";
import { parseAutomationsFile, type AutomationsFileParseResult } from "@dohc/workspace-contracts/automations";
import type { CollectionRecord } from "@dohc/workspace-contracts/collection";
import { isNormalizedRelativePath } from "@dohc/workspace-contracts/collection-values";
import { isSharedWithMePath } from "@dohc/workspace-core";
import {
  noAccessReason,
  relayedButtonState,
  relayedButtonTarget,
  RUNNING_FOR_RECORD,
  sharedDatasetButtonState,
} from "@dohc/automation-executor/automation-buttons";
import { documentButtonAccess } from "../automations/documentButtonAccess";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { AUTOMATIONS_FILE_NAME, type CollectionAutomationButton, type CollectionAutomations, type PressSettled, type PressWaitReason } from "@dohc/automation-executor/collection-automations";
import {
  ListAutomationButtonsPayload,
  ListRecordButtonsPayload,
  PressAutomationButtonPayload,
  type AutomationRunSettledEvent,
  type AutomationRunWaitingEvent,
  type ListAutomationButtonsResult,
  type ListRecordButtonsResult,
  type PressAutomationButtonResult,
} from "./bridgeContract";
import { CHANNELS } from "./channels";

// Button fields (item 8). Main decides who may press a button and which
// automation it runs; a window only shows the answer. A press acts for the
// person main is signed in as, never for a person a window names.

interface PressWindow {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

/**
 * The windows waiting to hear how a press's run ends. A window hears only
 * while it still shows the workspace it pressed in. A closed window drops
 * out when the next press registers, and a closed workspace drops its runs.
 */
export function createPressWindows<Sender extends PressWindow>(currentWorkspace: (sender: Sender) => string | null) {
  const watching = new Map<string, { workspaceId: string; senders: Set<Sender> }>();
  const keyOf = (workspaceId: string, claimId: string) => JSON.stringify([workspaceId, claimId]);
  const live = (workspaceId: string, claimId: string) =>
    [...(watching.get(keyOf(workspaceId, claimId))?.senders ?? [])]
      .filter((sender) => !sender.isDestroyed() && currentWorkspace(sender) === workspaceId);
  const sendWaiting = (sender: Sender, workspaceId: string, claimId: string, reason: PressWaitReason) => {
    const payload: AutomationRunWaitingEvent = { workspaceId, claimId, reason };
    sender.send(CHANNELS.automationRunWaiting, payload);
  };
  return {
    /** Registers a window for a run. A run that already waits tells that window why at once. */
    watch(workspaceId: string, claimId: string, sender: Sender, waiting: PressWaitReason | null): void {
      for (const [key, entry] of watching) {
        for (const watcher of entry.senders) if (watcher.isDestroyed()) entry.senders.delete(watcher);
        if (entry.senders.size === 0) watching.delete(key);
      }
      const key = keyOf(workspaceId, claimId);
      const entry = watching.get(key) ?? { workspaceId, senders: new Set<Sender>() };
      entry.senders.add(sender);
      watching.set(key, entry);
      if (waiting !== null) sendWaiting(sender, workspaceId, claimId, waiting);
    },
    settled(workspaceId: string, event: PressSettled): void {
      const payload: AutomationRunSettledEvent = { workspaceId, ...event };
      for (const sender of live(workspaceId, event.claimId)) sender.send(CHANNELS.automationRunSettled, payload);
      watching.delete(keyOf(workspaceId, event.claimId));
    },
    waiting(workspaceId: string, event: { claimId: string; reason: PressWaitReason }): void {
      for (const sender of live(workspaceId, event.claimId)) sendWaiting(sender, workspaceId, event.claimId, event.reason);
    },
    /** The workspace closed: its runs have no window left to tell. */
    forget(workspaceId: string): void {
      for (const [key, entry] of watching) if (entry.workspaceId === workspaceId) watching.delete(key);
    },
    /** How many runs have a window waiting, for tests. */
    size(): number {
      return watching.size;
    },
  };
}

export type PressWindows<Sender extends PressWindow> = ReturnType<typeof createPressWindows<Sender>>;

type TextFile = { text: string; truncated: boolean; contentHash: string | null };

/** Each Button field of the tables the host describes to this person, with its table. */
function describedButtons(description: DatasetDescription): Array<{ field: string; table: string }> {
  return description.tables.flatMap((table) => table.fields.flatMap((field) => field.type === "button" ? [{ field: field.name, table: table.name }] : []));
}

export function registerAutomationButtonsIpc<
  Sender extends PressWindow,
  Event extends { sender: Sender },
  Operation extends {
    readonly workspace: { readonly workspaceId: string; readonly rootPath: string; readonly shareView?: unknown };
    readonly state: { readonly collectionAutomations: CollectionAutomations };
  },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  withRendererWorkspaceOperation<Result>(
    sender: Sender, workspaceId: string, message: string,
    work: (operation: Operation) => Promise<Result>,
  ): Promise<Result>;
  readText(rootPath: string, relativePath: string): Promise<TextFile | null>;
  /** The Button fields the engine's schema for this Collection names, in schema order. */
  buttonFields(operation: Operation, collectionPath: string): Promise<string[]>;
  /** The record a file is, in the nearest document Collection that holds it, or null. */
  recordAt(operation: Operation, path: string): Promise<{ collectionPath: string; record: CollectionRecord } | null>;
  /** The dataset as the host describes it to this window's person. */
  describeDataset(sender: Sender, workspaceId: string, datasetId: string): Promise<DatasetDescription>;
  /** The person this computer is signed in as, or its own id when signed out. */
  pressedBy(): Promise<string>;
  /**
   * Sends a shared view's press to the relay, which records it for this
   * person's own grant and carries it to the owner's computer.
   */
  relayPress(operation: Operation, input: { pressId: string; automationId: string; definitionHash: string; recordId: string }): Promise<void>;
  pressWindows: PressWindows<Sender>;
}): void {
  const { registerHandler, assertTrustedSender, withRendererWorkspaceOperation, pressWindows } = dependencies;
  const stale = "Buttons stopped loading because this window changed workspaces.";
  const nameOf = (collectionPath: string) => collectionPath.split("/").at(-1) ?? collectionPath;

  function assertCollectionPath(path: string): void {
    if (!isNormalizedRelativePath(path) || isSharedWithMePath(path)) {
      throw new Error(`"${path}" is not a Collection in this workspace.`);
    }
  }

  /** The automations file a shared view holds for a Collection. */
  async function sharedAutomations(operation: Operation, collectionPath: string): Promise<AutomationsFileParseResult | null> {
    const read = await dependencies.readText(operation.workspace.rootPath, `${collectionPath}/${AUTOMATIONS_FILE_NAME}`);
    if (read === null) return null;
    return read.truncated ? { status: "unreadable", diagnostic: { code: "file-too-large", path: "" } } : parseAutomationsFile(read.text);
  }

  /**
   * A document Collection's buttons. This workspace's own run here; a shared
   * view's are read from its automations.yaml and run on the owner's
   * computer; anything less than Edit on the Collection's folder refuses all.
   */
  async function documentButtons(operation: Operation, collectionPath: string): Promise<CollectionAutomationButton[]> {
    const fields = await dependencies.buttonFields(operation, collectionPath);
    if (fields.length === 0) return [];
    const access = documentButtonAccess(operation.workspace.shareView, collectionPath);
    if (access === "no-access") {
      const reason = noAccessReason(nameOf(collectionPath));
      return fields.map((field) => ({ field, state: { kind: "disabled", reason } }));
    }
    if (access === "press") return await operation.state.collectionAutomations.buttons(collectionPath, fields);
    const file = await sharedAutomations(operation, collectionPath);
    return fields.map((field) => ({ field, state: relayedButtonState(file, collectionPath, field, nameOf(collectionPath)) }));
  }

  registerHandler(CHANNELS.listRecordButtons, async (event, payload) => {
    assertTrustedSender(event);
    const input = ListRecordButtonsPayload.parse(payload);
    // A file mounted under shared-with-me is a projection, not a record of
    // this workspace's Collections, so it has no buttons here.
    if (!isNormalizedRelativePath(input.path) || isSharedWithMePath(input.path)) return { record: null };
    return withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation): Promise<ListRecordButtonsResult> => {
      const found = await dependencies.recordAt(operation, input.path);
      if (found === null) return { record: null };
      return { ...found, buttons: await documentButtons(operation, found.collectionPath) };
    });
  });

  registerHandler(CHANNELS.listAutomationButtons, async (event, payload): Promise<ListAutomationButtonsResult> => {
    assertTrustedSender(event);
    const input = ListAutomationButtonsPayload.parse(payload);
    if ("datasetId" in input) {
      // The host describes the dataset to this window's person, so the access each button checks is theirs.
      const description = await dependencies.describeDataset(event.sender, input.workspaceId, input.datasetId);
      const buttons = describedButtons(description);
      if (buttons.length === 0) return { buttons: [] };
      const states = await withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation) =>
        shareViewIsPresent(operation.workspace.shareView)
          ? buttons.map(({ table }) => sharedDatasetButtonState(description, table))
          : await operation.state.collectionAutomations.datasetButtons(input.datasetId, buttons, description));
      return { buttons: buttons.map((button, index) => ({ ...button, state: states[index]! })) };
    }
    assertCollectionPath(input.collectionPath);
    const buttons = await withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, (operation) => documentButtons(operation, input.collectionPath));
    return { buttons: buttons.map((button) => ({ ...button, table: null })) };
  });

  registerHandler(CHANNELS.pressAutomationButton, async (event, payload): Promise<PressAutomationButtonResult> => {
    assertTrustedSender(event);
    const input = PressAutomationButtonPayload.parse(payload);
    const workspaceId = input.workspaceId;
    const pressedBy = await dependencies.pressedBy();
    const watch = (claimId: string, waiting: PressWaitReason | null) => pressWindows.watch(workspaceId, claimId, event.sender, waiting);
    if ("datasetId" in input) {
      const description = await dependencies.describeDataset(event.sender, workspaceId, input.datasetId);
      const pressed = await withRendererWorkspaceOperation(event.sender, workspaceId, stale, async (operation) => {
        if (shareViewIsPresent(operation.workspace.shareView)) {
          throw new Error(sharedDatasetButtonState(description, input.table).reason);
        }
        return await operation.state.collectionAutomations.pressDataset(
          { datasetId: input.datasetId, table: input.table, field: input.field, recordId: input.recordId, pressId: input.pressId, pressedBy },
          description, watch);
      });
      return pressed.busy ? { busy: true, reason: RUNNING_FOR_RECORD } : pressed;
    }
    assertCollectionPath(input.collectionPath);
    const read = await withRendererWorkspaceOperation(event.sender, workspaceId, stale, async (operation) => {
      // Checked before the executor or the relay is asked.
      const access = documentButtonAccess(operation.workspace.shareView, input.collectionPath);
      if (access === "no-access") throw new Error(noAccessReason(nameOf(input.collectionPath)));
      if (access === "relayed") {
        if (!(await dependencies.buttonFields(operation, input.collectionPath)).includes(input.field)) {
          throw new Error(`${input.field} is not a button in ${nameOf(input.collectionPath)}.`);
        }
        const file = await sharedAutomations(operation, input.collectionPath);
        const target = relayedButtonTarget(file, input.collectionPath, input.field, nameOf(input.collectionPath));
        if ("state" in target) throw new Error(target.state.reason);
        await dependencies.relayPress(operation, { pressId: input.pressId, ...target, recordId: input.recordId });
        return { kind: "relayed" as const };
      }
      const pressed = await operation.state.collectionAutomations.press(
        { collectionPath: input.collectionPath, field: input.field, recordId: input.recordId, pressId: input.pressId, pressedBy },
        watch,
        async () => {
          if (!(await dependencies.buttonFields(operation, input.collectionPath)).includes(input.field)) {
            throw new Error(`${input.field} is not a button in ${nameOf(input.collectionPath)}.`);
          }
        },
      );
      return { kind: "document" as const, pressed };
    });
    if (read.kind === "relayed") return { busy: false, relayed: true };
    const { pressed } = read;
    return pressed.busy ? { busy: true, reason: RUNNING_FOR_RECORD } : pressed;
  });
}
