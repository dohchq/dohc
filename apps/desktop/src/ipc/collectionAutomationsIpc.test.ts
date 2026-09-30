import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { writeAutomationsFile, type Automation } from "@dohc/workspace-contracts/automations";
import type { CollectionAutomationRun, CollectionAutomations } from "@dohc/automation-executor/collection-automations";
import { createServerRuns, type ServerAnswer, type ServerRequest } from "../automations/serverRuns";

type ServerReply = Omit<NonNullable<ServerAnswer>, "asker"> | null;
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

const run = (claimId: string, createdAtMs: number): CollectionAutomationRun => ({
  claimId, state: "failed", error: "boom", createdAtMs, updatedAtMs: createdAtMs, trigger: { kind: "changed", recordId: "record", by: "human", depth: 0, sharedAuthor: null }, writes: [], definitionChanged: false, neverStarted: false, chainStopped: false, undone: false,
});

function fixture(options: {
  file?: string;
  sharedView?: boolean;
  /** The relay's answers to the owner's server routes; null: this computer cannot ask as the owner. */
  server?: (request: ServerRequest) => ServerReply | Promise<ServerReply>;
} = {}) {
  const handlers = new Map<string, (event: { sender: string }, payload: unknown) => unknown>();
  const createFile = vi.fn(async () => ({ path: "Tasks/automations.yaml" }));
  const writeText = vi.fn(async (_event: unknown, payload: { text: string }) => ({ status: "written" as const, contentHash: sha256(payload.text) }));
  const reindexed: unknown[] = [];
  const fieldMarks = vi.fn(async (collectionPath: string) => [{ field: "Finished on", automations: [`Stamp in ${collectionPath}`] }]);
  const datasetFieldMarks = vi.fn(async (datasetId: string, table: string) => [{ field: "Status", automations: [`Close in ${datasetId} ${table}`] }]);
  const datasetCollection = vi.fn(async () => ({ status: "found" as const, collectionPath: "Budget" }));
  const pinOperations = vi.fn(async (_path: string, automations: readonly Automation[], _saved: readonly Automation[]) => [...automations]);
  const draftCannotRun = vi.fn(async (_path: string, _automation: Automation): Promise<string | null> => "Budget has no approved operation named gone.");
  const missingCodeFiles = vi.fn(async (_path: string, _automation: Automation): Promise<string[]> => []);
  const groupsFor = vi.fn(async (_path: string) => [{ name: "Trip", slug: "trip", ref: "Trip", readStopped: null, postStopped: "ana@dohc.test cannot post in Trip." }]);
  const peopleFor = vi.fn(async (_path: string) => ({ status: "listed" as const, people: [
    { userId: "user-ana", name: "ana@dohc.test", you: false, dmStopped: null, noticeStopped: "ana@dohc.test cannot view Tasks." },
  ] }));
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
  const retry = vi.fn(async () => ({ status: "queued" as const, press: false }));
  const undo = vi.fn(async () => ({ status: "refused" as const, reason: "here" }));
  const confirmReach = vi.fn(async () => "confirmed" as const);
  const asked: Array<[string, ServerRequest]> = [];
  const serverRuns = createServerRuns(async (workspaceId, request) => {
    asked.push([workspaceId, request]);
    const reply = options.server ? await options.server(request) : null;
    return reply && { ...reply, asker: { account: "owner", current: () => true } };
  });
  const executor = {
    runs, listedRun, retry, undo, confirmReach, pinOperations, draftCannotRun, missingCodeFiles, groupsFor, peopleFor, handleWatcherEvents: (events: unknown) => { reindexed.push(events); }, fieldMarks, datasetFieldMarks, datasetCollection, holdState: () => ({ holds: [], stops: [stop], unreadable: false, unprovenPaths: [] }), dismissStops, shareImpact } as unknown as CollectionAutomations;
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
    serverRuns,
    relayUnreachable: (error) => error instanceof TypeError,
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
  return { asked, retry, undo, confirmReach, write, call, marks, runs, oldRun, stop, shareStop, fieldMarks, datasetFieldMarks, datasetCollection, pinOperations, draftCannotRun, missingCodeFiles, groupsFor, peopleFor, dismissStops, shareImpact, check, createFile, writeText, reindexed };
}

describe("steps a share stops", () => {
  it("lists the stopped steps with the holds, and dismisses the verdicts the person saw", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.listAutomationHolds, {})).resolves.toEqual({ holds: [], stops: [f.stop], unreadable: false, unprovenPaths: [] });
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
    await expect(f.call(CHANNELS.listAutomationHolds, {})).resolves.toEqual({ holds: [], stops: [], unreadable: false, unprovenPaths: [] });
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
      missingFiles: [],
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
      diagnostics: [], formulaProblems: [{ path: "/if", problem: "Unexpected token." }], cannotRun: null, missingFiles: [],
    });
    // Main names the code files the executor cannot find, and a failed look names none.
    const coded = { ...stamp, do: [{ kind: "run-file", file: "total.js", as: null }] };
    f.missingCodeFiles.mockResolvedValueOnce(["total.js"]);
    await expect(f.check({ collectionPath: "Tasks", automation: coded })).resolves.toMatchObject({ missingFiles: ["total.js"] });
    expect(f.missingCodeFiles).toHaveBeenLastCalledWith("Tasks", coded);
    // Other problems in the draft do not hide a missing file.
    f.missingCodeFiles.mockResolvedValueOnce(["total.js"]);
    await expect(f.check({ collectionPath: "Tasks", automation: { ...coded, when: { kind: "record-removed", table: null }, do: [...coded.do, stamp.do[0]] } }))
      .resolves.toMatchObject({ diagnostics: [{ code: "step-needs-record" }], missingFiles: ["total.js"] });
    f.missingCodeFiles.mockRejectedValueOnce(new Error("The executor is not open."));
    await expect(f.check({ collectionPath: "Tasks", automation: coded })).resolves.toMatchObject({ missingFiles: [] });
    expect(f.createFile).not.toHaveBeenCalled();
  });
});

describe("listing the Groups the builder offers", () => {
  it("names each Group with why it cannot start or take the automation's message, and nothing in a shared view", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.listAutomationGroups, { collectionPath: "Tasks" })).resolves.toEqual({
      groups: [{ name: "Trip", slug: "trip", ref: "Trip", readStopped: null, postStopped: "ana@dohc.test cannot post in Trip." }],
    });
    expect(f.groupsFor).toHaveBeenCalledWith("Tasks");
    const shared = fixture({ sharedView: true });
    await expect(shared.call(CHANNELS.listAutomationGroups, { collectionPath: "Tasks" })).resolves.toEqual({ status: "unavailable" });
    expect(shared.groupsFor).not.toHaveBeenCalled();
    // A path outside the workspace is refused before anything is read.
    await expect(f.call(CHANNELS.listAutomationGroups, { collectionPath: "../Other" })).rejects.toThrow();
  });
});

describe("listing the people the builder offers", () => {
  it("names each person with why a step cannot reach them, and nobody in a shared view", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.listAutomationPeople, { collectionPath: "Tasks" })).resolves.toEqual({
      status: "listed",
      people: [{ userId: "user-ana", name: "ana@dohc.test", you: false, dmStopped: null, noticeStopped: "ana@dohc.test cannot view Tasks." }],
    });
    expect(f.peopleFor).toHaveBeenCalledWith("Tasks");
    const shared = fixture({ sharedView: true });
    await expect(shared.call(CHANNELS.listAutomationPeople, { collectionPath: "Tasks" })).resolves.toEqual({ status: "unavailable" });
    expect(shared.peopleFor).not.toHaveBeenCalled();
    // A path outside the workspace, or no path, is refused before anything is read.
    await expect(f.call(CHANNELS.listAutomationPeople, { collectionPath: "../Other" })).rejects.toThrow();
    await expect(f.call(CHANNELS.listAutomationPeople, {})).rejects.toThrow();
    expect(f.peopleFor).toHaveBeenCalledTimes(1);
  });
});

describe("reading a Collection's automation runs", () => {
  it("answers unavailable in a shared view, as the list does", async () => {
    const f = fixture({ sharedView: true });
    await expect(f.call(CHANNELS.listCollectionAutomationRuns, { automationId: "collection:Tasks#stamp" }))
      .resolves.toEqual({ status: "unavailable" });
    await expect(f.call(CHANNELS.getCollectionAutomationRun, { automationId: "collection:Tasks#stamp", claimId: "atc_old", onServer: false }))
      .resolves.toEqual({ status: "unavailable" });
  });

  it("reads the page after the one before, and one run by its id however old", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.listCollectionAutomationRuns, { automationId: "collection:Tasks#stamp", before: "5:atc_five" }))
      .resolves.toEqual({ status: "listed", runs: [], next: null });
    expect(f.runs).toHaveBeenCalledWith("collection:Tasks#stamp", "5:atc_five");
    await expect(f.call(CHANNELS.getCollectionAutomationRun, { automationId: "collection:Tasks#stamp", claimId: "atc_old", onServer: false }))
      .resolves.toEqual({ status: "found", run: f.oldRun });
    await expect(f.call(CHANNELS.getCollectionAutomationRun, { automationId: "collection:Tasks#stamp", claimId: "atc_gone", onServer: false }))
      .resolves.toEqual({ status: "missing" });
  });

  it("lists the server's runs apart from this computer's, and none where the server has no copy", async () => {
    const f = fixture({ server: () => ({ status: 200, body: { ok: true, runs: [run("server", 20)], next: null } }) });
    const automation = { automationId: "collection:Tasks#stamp" };
    await expect(f.call(CHANNELS.listCollectionAutomationRuns, automation)).resolves.toEqual({
      status: "listed", runs: [], next: null,
    });
    expect(f.asked).toEqual([]);
    await expect(f.call(CHANNELS.listServerAutomationRuns, automation)).resolves.toEqual({ runs: [run("server", 20)], next: null });
    expect(f.asked).toEqual([[WORKSPACE_ID, { method: "GET", action: "runs", query: automation }]]);
    for (const server of [() => null, () => ({ status: 404, body: { code: "not_found" } })]) {
      await expect(fixture({ server }).call(CHANNELS.listServerAutomationRuns, automation)).resolves.toEqual({ runs: null, next: null });
    }
    const shared = fixture({ server: () => ({ status: 200, body: { ok: true, runs: [] } }), sharedView: true });
    await expect(shared.call(CHANNELS.listServerAutomationRuns, automation)).resolves.toEqual({ runs: null, next: null });
    expect(shared.asked).toEqual([]);
  });

  it("reads the server's lists as empty offline, and passes on a failure the relay answered", async () => {
    const offline = fixture({ server: () => { throw new TypeError("fetch failed"); } });
    const automation = { automationId: "collection:Tasks#stamp" };
    await expect(offline.call(CHANNELS.listServerAutomationRuns, automation)).resolves.toEqual({ runs: null, next: null });
    await expect(offline.call(CHANNELS.listServerAutomationHolds, {})).resolves.toEqual({ holds: [] });
    await expect(offline.call(CHANNELS.undoCollectionAutomationRun, { ...automation, claimId: "claim-1", deletes: null, onServer: true })).rejects.toThrow("fetch failed");
    const failing = fixture({ server: () => ({ status: 500, body: {} }) });
    await expect(failing.call(CHANNELS.listServerAutomationHolds, {})).rejects.toThrow("Your server answered with 500.");
  });

  it("refuses an answer from the server that is not a run, or not a success", async () => {
    const automation = { automationId: "collection:Tasks#stamp" };
    await expect(fixture({ server: () => ({ status: 200, body: { ok: true, runs: [{ claimId: "server" }] } }) })
      .call(CHANNELS.listServerAutomationRuns, automation)).rejects.toThrow();
    await expect(fixture({ server: () => ({ status: 500, body: { code: "internal_error" } }) })
      .call(CHANNELS.listServerAutomationRuns, automation)).rejects.toThrow("Your server answered with 500.");
  });
});

describe("acting on a run where it ran", () => {
  const claim = { automationId: "collection:Tasks#stamp", claimId: "claim-1" };

  it("carries server pages, single-run lookup, delete confirmation, and every Undo count", async () => {
    const result = { status: "undone", reverted: 1, removed: 2, deleted: 3, kept: 4, keptChanged: 5, gone: 6,
      changedSince: 7, missing: 8, irreversible: 9, actions: 10, actionsReversed: 11 };
    const preview = { deletes: 3, unchecked: 1, kept: 4, keptChanged: 5, gone: 6, reverts: 1,
      irreversible: 9, reverses: 11, actions: 10, choices: [], token: "preview" };
    const f = fixture({ server: (request) => ({ status: 200, body: { ok: true,
      ...(request.method === "GET"
        ? request.query?.claimId ? { run: run("claim-1", 20) } : { runs: [run("claim-1", 20)], next: "20:claim-1" }
        : request.body.deletes === null ? { status: "confirm", preview } : result),
    } }) });
    await expect(f.call(CHANNELS.listServerAutomationRuns, { automationId: claim.automationId, before: "30:new" }))
      .resolves.toEqual({ runs: [run("claim-1", 20)], next: "20:claim-1" });
    expect(f.asked.at(-1)?.[1]).toEqual({ method: "GET", action: "runs", query: { automationId: claim.automationId, before: "30:new" } });
    await expect(f.call(CHANNELS.getCollectionAutomationRun, { ...claim, onServer: true }))
      .resolves.toEqual({ status: "found", run: run("claim-1", 20) });
    await expect(f.call(CHANNELS.undoCollectionAutomationRun, { ...claim, deletes: null, onServer: true }))
      .resolves.toEqual({ status: "confirm", preview });
    const deletes = { token: "preview", chosen: [{ key: "table", operationId: "delete" }] };
    await expect(f.call(CHANNELS.undoCollectionAutomationRun, { ...claim, deletes, onServer: true })).resolves.toEqual(result);
    expect(f.asked.at(-1)?.[1]).toEqual({ method: "POST", action: "undo", body: { ...claim, deletes } });
  });

  it("runs Try again, Undo, and Allow on this computer unless the run is the server's", async () => {
    const f = fixture({ server: (request) => ({ status: 200, body: { ok: true, ...(request.action === "allow" ? { status: "changed" } : { status: "refused", reason: "server" }) } }) });
    await expect(f.call(CHANNELS.retryCollectionAutomation, { ...claim, startOver: false, onServer: false })).resolves.toEqual({ status: "queued", press: false });
    await expect(f.call(CHANNELS.retryCollectionAutomation, { ...claim, startOver: true, onServer: true })).resolves.toEqual({ status: "refused", reason: "server" });
    await expect(f.call(CHANNELS.undoCollectionAutomationRun, { ...claim, deletes: null, onServer: false })).resolves.toEqual({ status: "refused", reason: "here" });
    await expect(f.call(CHANNELS.undoCollectionAutomationRun, { ...claim, deletes: null, onServer: true })).resolves.toEqual({ status: "refused", reason: "server" });
    const hold = { automationId: claim.automationId, definitionHash: "0123456789abcdef", step: "0", seq: 3 };
    await expect(f.call(CHANNELS.confirmCollectionAutomationStep, { ...hold, onServer: false })).resolves.toEqual({ status: "confirmed" });
    await expect(f.call(CHANNELS.confirmCollectionAutomationStep, { ...hold, onServer: true })).resolves.toEqual({ status: "changed" });
    expect(f.retry).toHaveBeenCalledTimes(1);
    expect(f.undo).toHaveBeenCalledTimes(1);
    expect(f.confirmReach).toHaveBeenCalledWith(hold);
    expect(f.asked.map(([, request]) => request)).toEqual([
      { method: "POST", action: "retry", body: { ...claim, startOver: true } },
      { method: "POST", action: "undo", body: { ...claim, deletes: null } },
      { method: "POST", action: "allow", body: hold },
    ]);
  });

  it("says the server no longer has a run it no longer answers for", async () => {
    const f = fixture({ server: () => ({ status: 404, body: {} }) });
    await expect(f.call(CHANNELS.undoCollectionAutomationRun, { ...claim, deletes: null, onServer: true }))
      .resolves.toEqual({ status: "refused", reason: "Your server no longer has this run." });
    await expect(f.call(CHANNELS.listServerAutomationHolds, {})).resolves.toEqual({ holds: [] });
  });

  it("lists the steps the server holds, and none in a shared view", async () => {
    const held = { automationId: "collection:Tasks#stamp", automationName: "Stamp", definitionHash: "0123456789abcdef", step: "0", seq: 3,
      collectionPath: "Tasks", collection: "Tasks", target: "Invoices", action: "change", stoppedFor: null, fileUnread: false };
    const server = () => ({ status: 200, body: { ok: true, holds: [held] } });
    await expect(fixture({ server }).call(CHANNELS.listServerAutomationHolds, {})).resolves.toEqual({ holds: [held] });
    const shared = fixture({ server, sharedView: true });
    await expect(shared.call(CHANNELS.listServerAutomationHolds, {})).resolves.toEqual({ holds: [] });
    expect(shared.asked).toEqual([]);
  });
});
