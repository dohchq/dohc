import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { CollectionAutomations } from "../automations/collectionAutomations";
import { CHANNELS } from "./channels";
import { registerCollectionAutomationsIpc } from "./collectionAutomationsIpc";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
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
  const fieldMarks = vi.fn(async (collectionPath: string) => [{ field: "Finished on", automations: [`Stamp in ${collectionPath}`] }]);
  const stop = {
    automationId: "collection:Trip#spend", automationName: "Spend", definitionHash: "0123456789abcdef", step: 0, seq: 3,
    collection: "Trip", target: "Budget", action: "change" as const, stoppedFor: "ana@dohc.test",
  };
  const dismissStops = vi.fn(async () => undefined);
  const shareStop = { automationId: "collection:Trip#spend", automationName: "Spend", collectionPath: "Trip", target: "Budget", action: "change" as const };
  const shareImpact = vi.fn(async () => [shareStop]);
  const executor = { fieldMarks, holdState: () => ({ holds: [], stops: [stop], unreadable: false }), dismissStops, shareImpact } as unknown as CollectionAutomations;
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
  });
  const write = (payload: Record<string, unknown>) =>
    handlers.get(CHANNELS.writeCollectionAutomations)!({ sender: "window" }, {
      workspaceId: WORKSPACE_ID, collectionPath: "Tasks", ...payload,
    });
  const call = (channel: string, payload: Record<string, unknown>) =>
    handlers.get(channel)!({ sender: "window" }, { workspaceId: WORKSPACE_ID, ...payload });
  const marks = (collectionPath: string) =>
    handlers.get(CHANNELS.listCollectionFieldMarks)!({ sender: "window" }, { workspaceId: WORKSPACE_ID, collectionPath });
  return { write, call, marks, stop, shareStop, fieldMarks, dismissStops, shareImpact, createFile, writeText };
}

describe("steps a share stops", () => {
  it("lists the stopped steps with the holds, and dismisses the verdicts the person saw", async () => {
    const f = fixture();
    await expect(f.call(CHANNELS.listAutomationHolds, {})).resolves.toEqual({ holds: [], stops: [f.stop], unreadable: false });
    const seen = { automationId: f.stop.automationId, definitionHash: f.stop.definitionHash, step: 0, seq: 3 };
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
});

describe("writing automations.yaml from the panel", () => {
  it("creates the file when the Collection has none, as the writer lays it out", async () => {
    const f = fixture();
    const result = await f.write({ expectedContentHash: null, automations: [stamp] });
    const text = (f.createFile.mock.calls[0] as unknown[])[1] as { initialText: string };
    expect(text.initialText).toContain("- id: stamp");
    expect(text.initialText).toContain("Finished on: '=today()'");
    expect(result).toEqual({ status: "written", contentHash: sha256(text.initialText) });
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
});

describe("reading a Collection's automation runs", () => {
  it("answers unavailable in a shared view, as the list does", async () => {
    await expect(fixture({ sharedView: true }).call(CHANNELS.listCollectionAutomationRuns, { automationId: "collection:Tasks#stamp" }))
      .resolves.toEqual({ status: "unavailable" });
  });
});
