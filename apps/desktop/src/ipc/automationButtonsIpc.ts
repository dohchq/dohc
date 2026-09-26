import { parseDatasetDefinition, type DatasetDefinition, type DatasetDescription } from "@dohc/security-contract/dataset";
import { parseAutomationsFile, type AutomationsFileParseResult } from "@dohc/workspace-contracts/automations";
import type { CollectionRecord } from "@dohc/workspace-contracts/collection";
import { isNormalizedRelativePath } from "@dohc/workspace-contracts/collection-values";
import { isSharedWithMePath } from "@dohc/workspace-core";
import {
  datasetButtonRefusal,
  documentButtonAccess,
  noAccessReason,
  relayedButtonState,
  relayedButtonTarget,
  RUNNING_FOR_RECORD,
} from "../automations/automationButtons";
import { AUTOMATIONS_FILE_NAME, type CollectionAutomations, type PressSettled, type PressWaitReason } from "../automations/collectionAutomations";
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

/** A dataset Collection as the button check reads it. */
interface DatasetButtons {
  definition: DatasetDefinition;
  file: AutomationsFileParseResult | null;
  /** Each Button field, with its table's name when the dataset has several tables. */
  buttons: Array<{ field: string; table: string | null }>;
}

/** Each Button field in a dataset, with its table named when the dataset has several. */
function datasetButtonsOf(definition: DatasetDefinition): DatasetButtons["buttons"] {
  return definition.tables.flatMap((table) => table.fields.flatMap((field) =>
    field.type === "button" ? [{ field: field.name, table: definition.tables.length === 1 ? null : table.name }] : []));
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

  /** A dataset Collection's descriptor and automations, or null for a document Collection. */
  async function readDataset(operation: Operation, collectionPath: string): Promise<DatasetButtons | null> {
    const { rootPath } = operation.workspace;
    const descriptor = await dependencies.readText(rootPath, `${collectionPath}/dataset.json`);
    if (descriptor === null) return null;
    if (descriptor.truncated) throw new Error(`dohc cannot read dataset.json in ${nameOf(collectionPath)}.`);
    const automations = await dependencies.readText(rootPath, `${collectionPath}/${AUTOMATIONS_FILE_NAME}`);
    const file: AutomationsFileParseResult | null = automations === null ? null
      : automations.truncated ? { status: "unreadable", diagnostic: { code: "file-too-large", path: "" } }
      : parseAutomationsFile(automations.text);
    const definition = parseDatasetDefinition(JSON.parse(descriptor.text));
    return { definition, file, buttons: datasetButtonsOf(definition) };
  }

  /**
   * Why this window's person cannot press each of a dataset's buttons.
   * The list and the press both ask this, in any workspace, so they say the
   * same thing. The host describes the dataset to this person once, so the
   * access is theirs, and a dataset button does not run yet, whatever the access.
   */
  async function datasetRefusals(
    sender: Sender, workspaceId: string, dataset: DatasetButtons, buttons: ReadonlyArray<{ field: string; table: string | null }>,
  ): Promise<string[]> {
    const description = await dependencies.describeDataset(sender, workspaceId, dataset.definition.datasetId);
    return buttons.map(({ field, table }) => datasetButtonRefusal({ definition: dataset.definition, file: dataset.file, description, field, table }));
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
  async function documentButtons(operation: Operation, collectionPath: string): Promise<ListAutomationButtonsResult["buttons"]> {
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
    assertCollectionPath(input.collectionPath);
    const read = await withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, async (operation) => {
      const dataset = await readDataset(operation, input.collectionPath);
      if (dataset !== null) return { kind: "dataset" as const, dataset };
      return { kind: "document" as const, buttons: await documentButtons(operation, input.collectionPath) };
    });
    if (read.kind === "document") return { buttons: read.buttons };
    const { buttons } = read.dataset;
    if (buttons.length === 0) return { buttons: [] };
    const reasons = await datasetRefusals(event.sender, input.workspaceId, read.dataset, buttons);
    return { buttons: buttons.map(({ field }, index) => ({ field, state: { kind: "disabled", reason: reasons[index]! } })) };
  });

  registerHandler(CHANNELS.pressAutomationButton, async (event, payload): Promise<PressAutomationButtonResult> => {
    assertTrustedSender(event);
    const input = PressAutomationButtonPayload.parse(payload);
    assertCollectionPath(input.collectionPath);
    const workspaceId = input.workspaceId;
    const pressedBy = await dependencies.pressedBy();
    const read = await withRendererWorkspaceOperation(event.sender, workspaceId, stale, async (operation) => {
      const dataset = await readDataset(operation, input.collectionPath);
      if (dataset !== null) return { kind: "dataset" as const, dataset };
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
        (claimId, waiting) => pressWindows.watch(workspaceId, claimId, event.sender, waiting),
        async () => {
          if (!(await dependencies.buttonFields(operation, input.collectionPath)).includes(input.field)) {
            throw new Error(`${input.field} is not a button in ${nameOf(input.collectionPath)}.`);
          }
        },
      );
      return { kind: "document" as const, pressed };
    });
    if (read.kind === "dataset") {
      const [reason] = await datasetRefusals(event.sender, workspaceId, read.dataset, [{ field: input.field, table: input.table }]);
      throw new Error(reason);
    }
    if (read.kind === "relayed") return { busy: false, relayed: true };
    const { pressed } = read;
    return pressed.busy ? { busy: true, reason: RUNNING_FOR_RECORD } : pressed;
  });
}
