import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { writeAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import type { CollectionAutomations } from "@dohc/automation-executor/collection-automations";
import { CHANNELS } from "./channels";
import { registerCollectionAutomationsIpc } from "./collectionAutomationsIpc";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const DATASET_ID = "22222222-2222-4222-8222-222222222222";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const stamp = {
  id: "stamp", name: "Stamp", enabled: true,
  when: { kind: "field-changed", field: "Status", to: { kind: "literal", value: "Done" }, table: null },
  if: null,
  do: [{ kind: "set", values: [{ field: "Finished on", value: { kind: "formula", expression: "today()" } }], records: null, operation: null }],
};

function fixture(options: { file?: string; sharedView?: boolean } = {}) {
  const handlers = new Map<string, (event: { sender: string }, payload: unknown) => unknown>();
  const createFile = vi.fn(async () => ({ path: "Tasks/automations.yaml" }));
  const writeText = vi.fn(async (_event: unknown, payload: { text: string }) => ({ status: "written" as const, contentHash: sha256(payload.text) }));
  const reindexed: unknown[] = [];
  const fieldMarks = vi.fn(async (collectionPath: string) => [{ field: "Finished on", automations: [`Stamp in ${collectionPath}`] }]);
  const datasetFieldMarks = vi.fn(async (datasetId: string, table: string) => [{ field: "Status", automations: [`Close in ${datasetId} ${table}`] }]);
  const datasetCollection = vi.fn(async () => ({ status: "found" as const, collectionPath: "Budget" }));
  const pinOperations = vi.fn(async (_path: string, automations: readonly Automation[], _saved: readonly Automation[]) => [...automations]);
  const draftCannotRun = vi.fn(async (_path: string, _automation: Automation): Promise<string | null> => "Budget has no approved operation named gone.");
  const stop = {
    automationId: "collection:Trip#spend", automationName: "Spend", definitionHash: "0123456789abcdef", step: "0", seq: 3,
    collection: "Trip", target: "Budget", action: "change" as const, stoppedFor: "ana@dohc.test",
  };
  const dismissStops = vi.fn(async () => undefined);
  const shareStop = { automationId: "collection:Trip#spend", automationName: "Spend", collectionPath: "Trip", target: "Budget", action: "change" as const };
  const shareImpact = vi.fn(async () => [shareStop]);
  const oldRun = { claimId: "atc_old", state: "done" as const, writes: [] };
  const runs = vi.fn(async () => ({ runs: [], next: null }));
  const listedRun = vi.fn(async (_automationId: string, claimId: string) => (claimId === oldRun.claimId ? oldRun : null));
  const executor = {
    runs, listedRun, pinOperations, draftCannotRun, handleWatcherEvents: (events: unknown) => { reindexed.push(events); }, fieldMarks, datasetFieldMarks, datasetCollection, holdState: () => ({ holds: [], stops: [stop], unreadable: false }), dismissStops, shareImpact } as unknown as CollectionAutomations;
  registerCollectionAutomationsIpc<string, { sender: string }, {
    workspace: { workspaceId: string; rootPath: string };
    state: { collectionAutomations: CollectionAutomations };
  }>({
    registerHandler: (channel, handler) => handlers.set(channel, handler),
    assertTrustedSender: () => undefined,
    withRendererWorkspaceOperation: async (_sender, _workspaceId, _message, work) =>
      await work({ workspace: { workspaceId: WORKSPACE_ID, rootPath: "/workspace" }, state: { collectionAutomations: executor } }),
    sharedViewOf: () => (options.sharedView ? {} : null),
    readText: async () => options.file === undefined ? null : { text: options.file, truncated: false, contentHash: sha256(options.file) },
    createFile,
    writeText,
    showItemInFolder: () => undefined,
    deletePath: async () => undefined,
    watchPress: () => undefined,
  });
  const write = (payload: Record<string, unknown>) =>
    handlers.get(CHANNELS.writeCollectionAutomations)!({ sender: "window" }, {
      workspaceId: WORKSPACE_ID, collectionPath: "Tasks", reformat: false, ...payload,
    });
  const call = (channel: string, payload: Record<string, unknown>) =>
    handlers.get(channel)!({ sender: "window" }, { workspaceId: WORKSPACE_ID, ...payload });
  const marks = (collectionPath: string) =>
    handlers.get(CHANNELS.listCollectionFieldMarks)!({ sender: "window" }, { workspaceId: WORKSPACE_ID, collectionPath });
  const check = (payload: Record<string, unknown>) => call(CHANNELS.checkCollectionAutomation, payload);
  return { write, call, marks, runs, oldRun, stop, shareStop, fieldMarks, datasetFieldMarks, datasetCollection, pinOperations, draftCannotRun, dismissStops, shareImpact, check, createFile, writeText, reindexed };
}

describe("steps a share stops", () => {
  it("lists the stopped steps with the holds, and dismisses the verdicts the person saw", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.listAutomationHolds, {})).resolves.toEqual({ holds: [], stops: [f.stop], unreadable: false });
    const seen = { automationId: f.stop.automationId, definitionHash: f.stop.definitionHash, step: "0", seq: 3 };
    await f.call(CHANNELS.dismissAutomationStops, { stops: [seen] });
    expect(f.dismissStops).toHaveBeenCalledWith([seen]);
  });

  it("asks the executor what a share with Edit would stop, as a share of paths", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.automationShareImpact, { recipientEmail: "ana@dohc.test", paths: ["Trip"], access: "edit" }))
      .resolves.toEqual({ stops: [f.shareStop] });
    expect(f.shareImpact).toHaveBeenCalledWith({ paths: ["Trip"], versionId: null, access: "edit", recipientEmail: "ana@dohc.test" });
    // A link names nobody yet.
    await f.call(CHANNELS.automationShareImpact, { recipientEmail: null, paths: ["Trip"], access: "edit" });
    expect(f.shareImpact).toHaveBeenLastCalledWith({ paths: ["Trip"], versionId: null, access: "edit", recipientEmail: null });
  });

  it("stops nothing and lists nothing in a shared view", async () => {
    const f = fixture({ sharedView: true });
    await expect(f.call(CHANNELS.listAutomationHolds, {})).resolves.toEqual({ holds: [], stops: [], unreadable: false });
    await expect(f.call(CHANNELS.automationShareImpact, { recipientEmail: "ana@dohc.test", paths: ["Trip"], access: "edit" }))
      .resolves.toEqual({ stops: [] });
    expect(f.shareImpact).not.toHaveBeenCalled();
  });
});

describe("field marks", () => {
  it("answers one Collection's marks from the executor, and none in a shared view", async () => {
    await expect(fixture().marks("Tasks")).resolves.toEqual({ marks: [{ field: "Finished on", automations: ["Stamp in Tasks"] }] });
    const shared = fixture({ sharedView: true });
    await expect(shared.marks("Tasks")).resolves.toEqual({ marks: [] });
    expect(shared.fieldMarks).not.toHaveBeenCalled();
    await expect(fixture().marks("shared-with-me/Trip")).rejects.toThrow(/not a Collection/);
  });

  it("answers one dataset table's marks by the dataset's id and the table's name, and none in a shared view", async () => {
    const input = { datasetId: DATASET_ID, table: "Invoices" };
    const f = fixture();
    await expect(f.call(CHANNELS.listCollectionFieldMarks, input)).resolves.toEqual({ marks: [{ field: "Status", automations: [`Close in ${DATASET_ID} Invoices`] }] });
    expect(f.fieldMarks).not.toHaveBeenCalled();
    const shared = fixture({ sharedView: true });
    await expect(shared.call(CHANNELS.listCollectionFieldMarks, input)).resolves.toEqual({ marks: [] });
    expect(shared.datasetFieldMarks).not.toHaveBeenCalled();
    // A payload that names both, or a dataset by something other than its id, is refused.
    await expect(f.call(CHANNELS.listCollectionFieldMarks, { ...input, collectionPath: "Budget" })).rejects.toThrow();
    await expect(f.call(CHANNELS.listCollectionFieldMarks, { datasetId: "Budget", table: "Invoices" })).rejects.toThrow();
  });
});

describe("finding a dataset Collection's automations", () => {
  it("names the folder that holds its automations.yaml, and in a shared view says they run on the owner's computer", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.findDatasetCollection, { datasetId: DATASET_ID })).resolves.toEqual({ status: "found", collectionPath: "Budget" });
    expect(f.datasetCollection).toHaveBeenCalledWith(DATASET_ID);
    const shared = fixture({ sharedView: true });
    await expect(shared.call(CHANNELS.findDatasetCollection, { datasetId: DATASET_ID })).resolves.toEqual({ status: "unavailable" });
    expect(shared.datasetCollection).not.toHaveBeenCalled();
  });
});

describe("writing automations.yaml from the panel", () => {
  it("creates the file when the Collection has none, as the writer lays it out", async () => {
    const f = fixture();
    const result = await f.write({ expectedContentHash: null, automations: [stamp] });
    const text = (f.createFile.mock.calls[0] as unknown[])[1] as { initialText: string };
    expect(text.initialText).toContain("- id: stamp");
    expect(text.initialText).toContain("Finished on: '=today()'");
    expect(result).toEqual({ status: "written", contentHash: sha256(text.initialText) });
    expect(f.reindexed).toEqual([[{ operation: "update", path: "Tasks/automations.yaml" }]]);
  });

  it("asks before it lays out a file that has comments or hand formatting", async () => {
    const file = "# Tasks\nversion: 1\nautomations: []\n";
    const f = fixture({ file });
    await expect(f.write({ expectedContentHash: sha256(file), automations: [stamp] })).resolves.toEqual({ status: "reformats" });
    expect(f.writeText).not.toHaveBeenCalled();
    await expect(f.write({ expectedContentHash: sha256(file), automations: [stamp], reformat: true }))
      .resolves.toMatchObject({ status: "written" });
  });

  it("replaces the file only over the content the panel read", async () => {
    const file = "version: 1\nautomations: []\n";
    const f = fixture({ file });
    await expect(f.write({ expectedContentHash: sha256("other"), automations: [stamp] })).resolves.toEqual({ status: "conflict" });
    expect(f.writeText).not.toHaveBeenCalled();
    await expect(f.write({ expectedContentHash: sha256(file), automations: [stamp] })).resolves.toMatchObject({ status: "written" });
    expect(f.writeText).toHaveBeenCalledWith({ sender: "window" }, expect.objectContaining({
      relativePath: "Tasks/automations.yaml", expectedContentHash: sha256(file),
    }));
  });

  it("tells pinning what the file holds now, so it pins only what the save changed", async () => {
    const saved = writeAutomationsFile([{ status: "valid", automation: stamp as Automation }]);
    if (saved.status !== "ok") throw new Error("The fixture should write.");
    const f = fixture({ file: saved.text });
    const switchedOff = { ...stamp, enabled: false };
    await expect(f.write({ expectedContentHash: sha256(saved.text), automations: [switchedOff] })).resolves.toMatchObject({ status: "written" });
    expect(f.pinOperations).toHaveBeenCalledWith("Tasks", [switchedOff], [stamp]);
    const fresh = fixture();
    await fresh.write({ expectedContentHash: null, automations: [stamp] });
    expect(fresh.pinOperations).toHaveBeenCalledWith("Tasks", [stamp], []);
  });

  it("refuses to write over entries dohc cannot read, and anything the file contract would turn off", async () => {
    const broken = "version: 1\nautomations:\n  - id: Not A Slug\n    name: Broken\n    when: record-added\n    do: [{set: {X: 1}}]\n";
    await expect(fixture({ file: broken }).write({ expectedContentHash: sha256(broken), automations: [stamp] }))
      .resolves.toEqual({ status: "unreadable" });
    const f = fixture();
    await expect(f.write({ expectedContentHash: null, automations: [{ ...stamp, id: "Not A Slug" }] }))
      .resolves.toMatchObject({ status: "refused", diagnostics: [{ code: "invalid-id" }] });
    await expect(f.write({ expectedContentHash: null, automations: [{ ...stamp, do: "set everything" }] }))
      .resolves.toMatchObject({ status: "refused" });
    expect(f.createFile).not.toHaveBeenCalled();
  });

  it("answers unavailable in a shared view, whose automations run on the owner's computer", async () => {
    await expect(fixture({ sharedView: true }).write({ expectedContentHash: null, automations: [stamp] }))
      .resolves.toEqual({ status: "unavailable" });
  });

  it("checks a draft the way a save would, and each formula's syntax without running it", async () => {
    const f = fixture();
    await expect(f.check({ collectionPath: "Tasks", automation: { ...stamp, if: "record.Status ==" } })).resolves.toEqual({
      diagnostics: [],
      formulaProblems: [{ path: "/if", problem: "Unexpected token." }],
      cannotRun: "Budget has no approved operation named gone.",
    });
    expect(f.draftCannotRun).toHaveBeenCalledWith("Tasks", { ...stamp, if: "record.Status ==" });
    const removed = { ...stamp, when: { kind: "record-removed", table: null } };
    // A draft the file contract refuses has no run status to check.
    await expect(f.check({ collectionPath: "Tasks", automation: removed }))
      .resolves.toMatchObject({ diagnostics: [{ code: "step-needs-record" }], cannotRun: null });
    expect(f.draftCannotRun).toHaveBeenCalledOnce();
    await expect(fixture({ sharedView: true }).check({ collectionPath: "Tasks", automation: stamp })).resolves.toMatchObject({ cannotRun: null });
    // An executor that is not open yet gives no status, and the rest of the check still answers.
    f.draftCannotRun.mockRejectedValueOnce(new Error("The executor is not open."));
    await expect(f.check({ collectionPath: "Tasks", automation: { ...stamp, if: "record.Status ==" } })).resolves.toEqual({
      diagnostics: [], formulaProblems: [{ path: "/if", problem: "Unexpected token." }], cannotRun: null,
    });
    expect(f.createFile).not.toHaveBeenCalled();
  });
});

describe("reading a Collection's automation runs", () => {
  it("answers unavailable in a shared view, as the list does", async () => {
    const f = fixture({ sharedView: true });
    await expect(f.call(CHANNELS.listCollectionAutomationRuns, { automationId: "collection:Tasks#stamp" }))
      .resolves.toEqual({ status: "unavailable" });
    await expect(f.call(CHANNELS.getCollectionAutomationRun, { automationId: "collection:Tasks#stamp", claimId: "atc_old" }))
      .resolves.toEqual({ status: "unavailable" });
  });

  it("reads the page after the one before, and one run by its id however old", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.listCollectionAutomationRuns, { automationId: "collection:Tasks#stamp", before: "5:atc_five" }))
      .resolves.toEqual({ status: "listed", runs: [], next: null });
    expect(f.runs).toHaveBeenCalledWith("collection:Tasks#stamp", "5:atc_five");
    await expect(f.call(CHANNELS.getCollectionAutomationRun, { automationId: "collection:Tasks#stamp", claimId: "atc_old" }))
      .resolves.toEqual({ status: "found", run: f.oldRun });
    await expect(f.call(CHANNELS.getCollectionAutomationRun, { automationId: "collection:Tasks#stamp", claimId: "atc_gone" }))
      .resolves.toEqual({ status: "missing" });
  });
});
