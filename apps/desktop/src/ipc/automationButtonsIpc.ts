import { createHash } from "node:crypto";
import type { AutomationPressActor } from "@dohc/workspace-engine-client";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { RelayButtonInspection, RelayButtonTarget } from "@dohc/workspace-contracts/relay";
import { SHARED_BUTTON_UNCHECKED } from "@dohc/automation-executor/button-presser";
import { definitionHash, parseCollectionAutomationId } from "@dohc/automation-executor/automation-plan";
import { parseAutomationsFile, type AutomationsFileParseResult } from "@dohc/workspace-contracts/automations";
import type { CollectionRecord } from "@dohc/workspace-contracts/collection";
import { isNormalizedRelativePath } from "@dohc/workspace-contracts/collection-values";
import { isSharedWithMePath } from "@dohc/workspace-core";
import {
  BUTTON_CHECKING,
  noAccessReason,
  type IrreversibleAction,
  resolveButton,
  type AutomationButtonState,
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
import type { RemoteDatasetData } from "../workspaces/remoteDataset";

// Button fields (item 8). Main decides who may press a button and which
// automation it runs; a window only shows the answer. A press acts for the
// person main is signed in as, never for a person a window names.

/** A changed sign-in invalidates answers and makes open shared tables ask again. */
export function refreshSharedButtonInspections(clear: () => void, sharedWorkspaceIds: readonly string[], notify: (workspaceId: string) => void): void {
  clear();
  for (const workspaceId of sharedWorkspaceIds) notify(workspaceId);
}

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

/**
 * Where one press comes from: a window, or the CLI socket. The press runs
 * under the caller's workspace operation, reads the dataset as the host
 * describes it to the caller, and tells `watch` about the run it starts.
 */
export interface PressCaller<Operation> {
  /**
   * Who is pressing for main's person: the person in a window, or an agent
   * from the CLI at its run's depth. It never comes from a payload.
   */
  by: AutomationPressActor;
  withOperation<Result>(work: (operation: Operation) => Promise<Result>): Promise<Result>;
  describeDataset(datasetId: string): Promise<DatasetDescription>;
  watch(claimId: string, waiting: PressWaitReason | null): void;
}

type SharedButton = { target?: RelayButtonTarget; state: AutomationButtonState };
/** A press's answer, and whether the server runs it, so nothing here hears how it ends. */
type ButtonPresser<Operation> = (input: PressAutomationButtonPayload, caller: PressCaller<Operation>, inspected?: SharedButton) =>
  Promise<{ result: PressAutomationButtonResult; onServer: boolean }>;

/** A press as the CLI names it: a Collection's folder, a Button field, and a record. */
export interface NamedPress {
  workspaceId: string;
  collectionPath: string;
  field: string;
  /** A document record's id, or a dataset record's primary key as JSON. */
  recordId: string;
  /** The dataset table, needed only when the field is a button in more than one. */
  table?: string;
  /** The names of the actions dohc cannot undo that the caller chose to run. */
  confirm: readonly string[];
  /** The caller's key for this press. The same key sent again names the same press. */
  pressKey: string;
}

/**
 * A named press's id, from its key, its Collection, and the Collection's
 * kind. The executor remembers presses by id across restarts, in one ledger
 * for document Collections and one per dataset, so a folder that became a
 * dataset since never answers with the other ledger's press.
 */
function namedPressId(input: NamedPress, kind: "document" | "dataset"): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(["dohc-named-press", input.workspaceId, input.collectionPath, kind, input.pressKey]))
    .digest("hex");
  // Version 8, a custom UUID, and the RFC 9562 variant.
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A named press's answer, or the actions it would run that dohc cannot undo, which the caller must confirm first. */
export type NamedPressResult = PressAutomationButtonResult | { confirm: IrreversibleAction[] };

export function registerAutomationButtonsIpc<
  Sender extends PressWindow,
  Event extends { sender: Sender },
  Operation extends {
    readonly workspace: { readonly workspaceId: string; readonly rootPath: string; readonly shareView?: unknown; readonly attachmentId?: symbol };
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
  relayPress(operation: Operation, input: { pressId: string; automationId: string; collectionPath: string; definitionHash: string; recordId: string; confirmed: readonly string[] }): Promise<void>;
  relayInspect(operation: Operation, input: readonly RelayButtonTarget[]): Promise<RelayButtonInspection[]>;
  /**
   * The server a dataset Collection moved to, which runs its automations and
   * takes its presses, or null for a Collection kept on this computer.
   */
  serverCollection(operation: Operation, datasetId: string): Promise<{ data: Pick<RemoteDatasetData, "press"> } | null>;
  inspectionAccount(): Promise<string | null>;
  inspectionChanged(workspaceId: string, attachmentId: symbol | undefined): void;
  pressWindows: PressWindows<Sender>;
}): {
  pressNamed(input: NamedPress, caller: PressCaller<Operation>): Promise<NamedPressResult>;
  inspectNamed(input: Pick<NamedPress, "collectionPath" | "table">, caller: PressCaller<Operation>): Promise<CollectionAutomationButton[]>;
  clearInspections(): void;
} {
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

  const inspections = new Map<string, { at: number; pending: boolean; scope: object | symbol; buttons: SharedButton[] }>();
  /**
   * A shared view's buttons. "now" asks the host and waits, as a press does.
   * A listing answers at once from the last answer, or as checking while the
   * host is asked in the background; "fresh" asks again whatever was cached.
   */
  async function sharedButtons(operation: Operation, collectionPath: string, fields: readonly string[], mode: "now" | "cached" | "fresh" = "now"): Promise<SharedButton[]> {
    const file = await sharedAutomations(operation, collectionPath);
    const buttons: SharedButton[] = fields.map(field => {
      const resolved = resolveButton(file, field, table => table === null, nameOf(collectionPath));
      if (resolved.kind === "state") return { state: resolved.state };
      return { target: { automationId: resolved.automation.id, definitionHash: definitionHash(resolved.automation), collectionPath }, state: { kind: "checking", reason: BUTTON_CHECKING } };
    });
    const targets = buttons.flatMap(button => button.target ? [button.target] : []);
    if (targets.length === 0) return buttons;
    const account = await dependencies.inspectionAccount();
    if (account === null) return buttons.map(() => ({ state: { kind: "disabled", reason: "Sign in with Edit access to use this button." } }));
    const refresh = async () => {
      const answers = await dependencies.relayInspect(operation, targets).catch(() => targets.map((): RelayButtonInspection => ({ kind: "unchecked", reason: SHARED_BUTTON_UNCHECKED })));
      let index = 0;
      return buttons.map((button): SharedButton => {
        const target = button.target;
        if (!target) return button;
        const answer = answers[index++];
        // No answer, or one for another definition, is not an answer.
        const unknown = { target, state: { kind: "unchecked" as const, reason: SHARED_BUTTON_UNCHECKED } };
        if (!answer) return unknown;
        if (answer.kind !== "ready") return { state: { kind: answer.kind === "denied" ? "disabled" as const : "unchecked" as const, reason: answer.reason } };
        if (parseCollectionAutomationId(answer.automationId)?.id !== target.automationId || answer.definitionHash !== target.definitionHash) return unknown;
        return { target: { ...target, automationId: answer.automationId }, state: { kind: "ready" as const, automationId: answer.automationId, ...(answer.irreversible.length ? { irreversible: answer.irreversible } : {}) } };
      });
    };
    if (mode === "now") return refresh();
    const key = JSON.stringify([account, operation.workspace.workspaceId, operation.workspace.rootPath, operation.workspace.shareView, collectionPath, fields, file, targets]);
    const cached = inspections.get(key);
    const scope = operation.workspace.attachmentId ?? operation.workspace;
    const recent = mode === "cached" && cached?.scope === scope && Date.now() - cached.at < 120_000;
    if (mode === "cached" && cached?.scope === scope && (cached.pending || Date.now() - cached.at < 5_000)) {
      inspections.delete(key);
      inspections.set(key, cached);
      if (!recent) cached.buttons = buttons;
      return cached.buttons;
    }
    const lastButtons = recent ? cached.buttons : buttons;
    const entry = { at: recent ? cached.at : 0, pending: true, scope, buttons: lastButtons };
    const { workspaceId, attachmentId } = operation.workspace;
    inspections.delete(key);
    inspections.set(key, entry);
    // Bound old Collections and definitions retained by the listing cache.
    if (inspections.size > 100) inspections.delete(inspections.keys().next().value!);
    void refresh().then(answer => {
      if (inspections.get(key) !== entry) return;
      const changed = JSON.stringify(answer) !== JSON.stringify(entry.buttons);
      entry.buttons = answer;
      entry.at = Date.now();
      entry.pending = false;
      if (changed) dependencies.inspectionChanged(workspaceId, attachmentId);
    });
    return lastButtons;
  }

  /**
   * A document Collection's buttons. This workspace's own run here; a shared
   * view's are read from its automations.yaml and run on the owner's
   * computer; anything less than Edit on the Collection's folder refuses all.
   */
  async function documentButtons(operation: Operation, collectionPath: string, describe: (datasetId: string) => Promise<DatasetDescription>, check = false): Promise<CollectionAutomationButton[]> {
    let fields: string[];
    try {
      fields = await dependencies.buttonFields(operation, collectionPath);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "collection-not-found") throw error;
      const schema = await dependencies.readText(operation.workspace.rootPath, `${collectionPath}/collection.yaml`);
      if (schema === null) throw error;
      return [];
    }
    if (fields.length === 0) return [];
    const access = documentButtonAccess(operation.workspace.shareView, collectionPath);
    if (access === "no-access") {
      const reason = noAccessReason(nameOf(collectionPath));
      return fields.map((field) => ({ field, state: { kind: "disabled", reason } }));
    }
    if (access === "press") return await operation.state.collectionAutomations.buttons(collectionPath, fields, describe);
    const buttons = await sharedButtons(operation, collectionPath, fields, check ? "fresh" : "cached");
    return fields.map((field, index) => ({ field, state: buttons[index]!.state }));
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
      return { ...found, fields: await dependencies.buttonFields(operation, found.collectionPath) };
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
          : await operation.state.collectionAutomations.datasetButtons(input.datasetId, buttons, (id) => id === input.datasetId ? Promise.resolve(description) : dependencies.describeDataset(event.sender, input.workspaceId, id)));
      return { buttons: buttons.map((button, index) => ({ ...button, state: states[index]! })) };
    }
    assertCollectionPath(input.collectionPath);
    const buttons = await withRendererWorkspaceOperation(event.sender, input.workspaceId, stale, (operation) => documentButtons(operation, input.collectionPath, (id) => dependencies.describeDataset(event.sender, input.workspaceId, id), input.check === true));
    return { buttons: buttons.map((button) => ({ ...button, table: null })) };
  });

  /**
   * One press, from a window or the CLI. A press acts for the person main is
   * signed in as, and the executor checks the button, the record, and who may
   * run it, whoever asked.
   */
  const press: ButtonPresser<Operation> = async (input, caller, inspectedButton) => {
    const pressedBy = await dependencies.pressedBy();
    const watch = caller.watch;
    if ("datasetId" in input) {
      const description = await caller.describeDataset(input.datasetId);
      const { pressed, onServer } = await caller.withOperation(async (operation) => {
        if (shareViewIsPresent(operation.workspace.shareView)) {
          throw new Error(sharedDatasetButtonState(description, input.table).reason);
        }
        const press = { datasetId: input.datasetId, table: input.table, field: input.field, recordId: input.recordId, pressId: input.pressId, by: caller.by, confirmed: input.confirmed ?? [] };
        // The server checks the press as the person it signed in, and runs it.
        const server = await dependencies.serverCollection(operation, input.datasetId);
        if (server !== null) return { pressed: await server.data.press(press), onServer: true };
        return { pressed: await operation.state.collectionAutomations.pressDataset({ ...press, pressedBy },
          (id) => id === input.datasetId ? Promise.resolve(description) : caller.describeDataset(id), watch), onServer: false };
      });
      return { result: pressed.busy ? { busy: true, reason: RUNNING_FOR_RECORD } : pressed, onServer };
    }
    assertCollectionPath(input.collectionPath);
    const read = await caller.withOperation(async (operation) => {
      // Checked before the executor or the relay is asked.
      const access = documentButtonAccess(operation.workspace.shareView, input.collectionPath);
      if (access === "no-access") throw new Error(noAccessReason(nameOf(input.collectionPath)));
      if (access === "relayed") {
        if (!(await dependencies.buttonFields(operation, input.collectionPath)).includes(input.field)) {
          throw new Error(`${input.field} is not a button in ${nameOf(input.collectionPath)}.`);
        }
        const inspected = inspectedButton ?? (await sharedButtons(operation, input.collectionPath, [input.field]))[0]!;
        if (inspected.state.kind !== "ready" || !inspected.target) throw new Error(inspected.state.kind === "ready" ? SHARED_BUTTON_UNCHECKED : inspected.state.reason);
        if ((inspected.state.irreversible ?? []).some(action => !input.confirmed?.includes(action.name))) throw new Error(`${input.field} changed after it was pressed. Press it again.`);
        await dependencies.relayPress(operation, { pressId: input.pressId, ...inspected.target, recordId: input.recordId, confirmed: input.confirmed ?? [] });
        return { kind: "relayed" as const };
      }
      const pressed = await operation.state.collectionAutomations.press(
        { collectionPath: input.collectionPath, field: input.field, recordId: input.recordId, pressId: input.pressId, pressedBy, by: caller.by, confirmed: input.confirmed ?? [] },
        watch,
        async () => {
          if (!(await dependencies.buttonFields(operation, input.collectionPath)).includes(input.field)) {
            throw new Error(`${input.field} is not a button in ${nameOf(input.collectionPath)}.`);
          }
        },
        caller.describeDataset,
      );
      return { kind: "document" as const, pressed };
    });
    if (read.kind === "relayed") return { result: { busy: false, relayed: true }, onServer: false };
    const { pressed } = read;
    return { result: pressed.busy ? { busy: true, reason: RUNNING_FOR_RECORD } : pressed, onServer: false };
  };

  registerHandler(CHANNELS.pressAutomationButton, async (event, payload): Promise<PressAutomationButtonResult> => {
    assertTrustedSender(event);
    const input = PressAutomationButtonPayload.parse(payload);
    const workspaceId = input.workspaceId;
    const { result, onServer } = await press(input, {
      by: { kind: "human" },
      withOperation: (work) => withRendererWorkspaceOperation(event.sender, workspaceId, stale, work),
      describeDataset: (datasetId) => dependencies.describeDataset(event.sender, workspaceId, datasetId),
      // The window that pressed hears how the run settles.
      watch: (claimId, waiting) => pressWindows.watch(workspaceId, claimId, event.sender, waiting),
    });
    // Nothing here hears how the server's run ends: the button is free again, and a failure arrives as the server's notice.
    return onServer && "claimId" in result && result.settled === null ? { busy: false, relayed: true } : result;
  });

  /**
   * A press named by the Collection's folder, as the CLI and MCP send it. A
   * shared view's press is a document press, which the app relays to the
   * owner's computer. A new press of a dataset's button reads the button the
   * way the app lists it, so a press that runs an action dohc cannot undo
   * asks first, as the app's question does, and runs only the actions the
   * caller confirmed by name. A press sent again answers its first run.
   */
  async function pressNamed(input: NamedPress, caller: PressCaller<Operation>): Promise<NamedPressResult> {
    assertCollectionPath(input.collectionPath);
    const { workspaceId, collectionPath, field, recordId } = input;
    const datasetId = await caller.withOperation((operation) => shareViewIsPresent(operation.workspace.shareView)
      ? Promise.resolve(null)
      : operation.state.collectionAutomations.datasetIn(collectionPath));
    if (datasetId === null) {
      const pressId = namedPressId(input, "document");
      let inspected: SharedButton | undefined;
      const unconfirmed = await caller.withOperation(async (operation) => {
        if (shareViewIsPresent(operation.workspace.shareView)) {
          inspected = (await sharedButtons(operation, collectionPath, [field]))[0]!;
          const { state } = inspected;
          if (state.kind !== "ready") throw new Error(state.reason);
          return (state.irreversible ?? []).filter(action => !input.confirm.includes(action.name));
        }
        if (await operation.state.collectionAutomations.documentPressed({ collectionPath, field, pressId })) return [];
        const [button] = await operation.state.collectionAutomations.buttons(collectionPath, [field], caller.describeDataset);
        if (button === undefined) throw new Error(`${field} did not start.`);
        if (button.state.kind !== "ready") throw new Error(button.state.reason);
        return (button.state.irreversible ?? []).filter((action) => !input.confirm.includes(action.name));
      });
      if (unconfirmed.length > 0) return { confirm: unconfirmed };
      return (await press({ workspaceId, collectionPath, field, recordId, pressId, confirmed: [...input.confirm] }, caller, inspected)).result;
    }
    const pressId = namedPressId(input, "dataset");
    const description = await caller.describeDataset(datasetId);
    const named = describedButtons(description)
      .filter((button) => button.field === field && (input.table === undefined || button.table === input.table));
    if (named.length > 1) throw new Error(`${field} is a button in more than one table of ${nameOf(collectionPath)}. Name the table.`);
    // A press sent again may name a button renamed since; its table is the one it named.
    const table = named[0]?.table ?? input.table;
    if (table === undefined) throw new Error(`${field} is not a button in ${nameOf(collectionPath)}.`);
    // What a new press needs first: a ready button, and every action dohc cannot undo confirmed by name.
    const asks = async (): Promise<{ confirm: IrreversibleAction[] } | null> => {
      const [state] = await caller.withOperation((operation) =>
        operation.state.collectionAutomations.datasetButtons(datasetId, [{ field, table }], (id) => id === datasetId ? Promise.resolve(description) : caller.describeDataset(id)));
      if (state === undefined || state.kind !== "ready") throw new Error(state?.reason ?? `${field} did not start.`);
      const unconfirmed = (state.irreversible ?? []).filter((action) => !input.confirm.includes(action.name));
      return unconfirmed.length > 0 ? { confirm: unconfirmed } : null;
    };
    const send = async () => (await press(
      { workspaceId, datasetId, table, field, recordId, pressId, confirmed: [...input.confirm] },
      { ...caller, describeDataset: (id) => id === datasetId ? Promise.resolve(description) : caller.describeDataset(id) },
    )).result;
    if (await caller.withOperation(async (operation) => (await dependencies.serverCollection(operation, datasetId)) !== null)) {
      // The server answers a press it remembers, however the button changed
      // since, and checks a new one itself, confirmations included. Only a
      // press it refuses is checked here, to say why.
      try { return await send(); }
      catch (error) {
        const asked = await asks();
        if (asked !== null) return asked;
        throw error;
      }
    }
    if (!(await caller.withOperation((operation) => operation.state.collectionAutomations.datasetPressed(pressId)))) {
      const asked = await asks();
      if (asked !== null) return asked;
    }
    return await send();
  }

  async function inspectNamed(input: Pick<NamedPress, "collectionPath" | "table">, caller: PressCaller<Operation>): Promise<CollectionAutomationButton[]> {
    assertCollectionPath(input.collectionPath);
    return caller.withOperation(async operation => {
      const datasetId = shareViewIsPresent(operation.workspace.shareView) ? null : await operation.state.collectionAutomations.datasetIn(input.collectionPath);
      if (datasetId === null) {
        const fields = await dependencies.buttonFields(operation, input.collectionPath);
        const access = documentButtonAccess(operation.workspace.shareView, input.collectionPath);
        if (access !== "relayed") return documentButtons(operation, input.collectionPath, caller.describeDataset);
        const buttons = await sharedButtons(operation, input.collectionPath, fields);
        return fields.map((field, index) => ({ field, state: buttons[index]!.state }));
      }
      const description = await caller.describeDataset(datasetId);
      const buttons = describedButtons(description).filter(button => input.table === undefined || button.table === input.table);
      const states = await operation.state.collectionAutomations.datasetButtons(datasetId, buttons, caller.describeDataset);
      return buttons.map((button, index) => ({ ...button, state: states[index]! }));
    });
  }
  return { pressNamed, inspectNamed, clearInspections: () => inspections.clear() };
}
