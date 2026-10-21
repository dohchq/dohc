import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GetWorkspaceUiStateResult, WorkspaceUiState } from "../../ipc/bridgeContract";
import { readUiStateFile, writeUiStateFile } from "../../workspaces/workspaceUiState";
import { createTestScratch } from "../../workspaces/testTemp";
import { fakeLocalStateOpens } from "../../testing/preparedLocalState";
import { ABOUT_DEFAULT_WIDTH, allTabs, defaultWorkbenchState, parseTab, parseUiState, serializeUiState } from "./workbenchState";

const engine = fakeLocalStateOpens();
// A workspace whose engine open prepared .dohc/local.
async function openedWorkspace(prefix: string) {
  const workspace = { workspaceId: prefix, rootPath: await createTestScratch(prefix) };
  await engine.open(workspace);
  return workspace;
}

async function fixture(version: 2 | 3) {
  return JSON.parse(await readFile(new URL(`./fixtures/ui-state-v${version}.json`, import.meta.url), "utf8"));
}

// A version-2 file predates the About rail: its right-panel fields were
// chatsVisible and chatsWidth, which nothing reads, so the rail opens closed.
async function migratedFixture() {
  const current = await fixture(3);
  current.editorGroups[0].tabs = current.editorGroups[0].tabs.filter((path: string) => !path.startsWith("tab://data-collection/"));
  return { ...current, aboutVisible: false, aboutWidth: ABOUT_DEFAULT_WIDTH };
}

describe("a layout saved before the About rail", () => {
  it("opens with the About rail closed and keeps everything else", async () => {
    const current = await fixture(3);
    const { aboutVisible: _visible, aboutWidth: _width, ...rest } = current;
    const old = { ...rest, chatsVisible: true, chatsWidth: 444 };
    const workspace = await openedWorkspace("ui-state-old-rail-");
    await writeUiStateFile(workspace, old);
    const restored = parseUiState(GetWorkspaceUiStateResult.parse(await readUiStateFile(workspace.rootPath)));
    expect(restored).toEqual({
      ...parseUiState(current),
      aboutVisible: false,
      aboutWidth: ABOUT_DEFAULT_WIDTH,
    });
    const written = WorkspaceUiState.parse(serializeUiState(restored));
    expect(written).not.toHaveProperty("chatsVisible");
    expect(written).not.toHaveProperty("chatsWidth");
  });
});

describe("UI-state v2 to v3", () => {
  it("migrates every current tab kind and active reference while preserving the other state", async () => {
    const old = await fixture(2);
    const before = structuredClone(old);
    expect(serializeUiState(parseUiState(old))).toEqual(await migratedFixture());
    expect(old).toEqual(before);
    expect(old.editorGroups[0].tabs).toContain("dohc://data-collection/123e4567-e89b-42d3-a456-426614174001/123e4567-e89b-42d3-a456-426614174002");
    expect(allTabs(parseUiState(old)).some(tab => tab.path.includes("data-collection"))).toBe(false);
  });

  it("reads a v2 file through the IPC schema, writes v3, and round-trips through disk and the renderer", async () => {
    const workspace = await openedWorkspace("ui-state-migration-");
    await writeUiStateFile(workspace, await fixture(2));
    const restored = parseUiState(GetWorkspaceUiStateResult.parse(await readUiStateFile(workspace.rootPath)));
    const v3 = WorkspaceUiState.parse(serializeUiState(restored));
    expect(v3).toEqual(await migratedFixture());
    await writeUiStateFile(workspace, v3);
    const read = GetWorkspaceUiStateResult.parse(await readUiStateFile(workspace.rootPath));
    expect(read).toEqual(v3);
    expect(parseUiState(read)).toEqual(restored);
  });

  it("deduplicates migrated singleton identities and transfers focus to their owner", () => {
    const state = parseUiState({
      version: 2,
      editorGroups: [
        { id: "left", tabs: ["dohc://app/apps%2Ftrip"], activeTab: "dohc://app/apps%2Ftrip", size: 1 },
        { id: "right", tabs: ["note.md", "dohc://app/%61pps%2Ftrip"], activeTab: "dohc://app/%61pps%2Ftrip", size: 1 },
      ],
      activeEditorGroup: "right",
    });
    expect(allTabs(state).map(tab => tab.path)).toEqual(["tab://app/apps%2Ftrip", "note.md"]);
    expect(state.activeEditorGroup).toBe("left");
    expect(state.editorGroups[0].activeTab).toBe("tab://app/apps%2Ftrip");
  });

  it("drops retired tabs and malformed singleton ids after migration", () => {
    const state = parseUiState({
      version: 2,
      editorGroups: [{ id: "main", size: 1, activeTab: "dohc://plugin-panel/old", tabs: [
        "dohc://plugin-panel/old", "dohc://plugin-web/old", "dohc://plugin-details/old",
        "dohc://retired/old", "dohc://app/%ZZ", "dohc://chats/dm/%ZZ", "note.md",
      ] }],
      activeEditorGroup: "main",
    });
    expect(state.editorGroups[0].tabs).toEqual([{ path: "note.md" }]);
    expect(state.editorGroups[0].activeTab).toBe("note.md");
  });

  it("does not treat old tab ids as aliases in v3", async () => {
    const old = await fixture(2);
    const state = parseUiState({ ...old, version: 3 });
    expect(allTabs(state).every(tab => !tab.path.startsWith("dohc://"))).toBe(true);
    expect(allTabs(state).some(tab => tab.path.startsWith("tab://"))).toBe(false);
  });

  it.each([2, 3])("preserves POSIX file paths starting with tab: in version %s", version => {
    const paths = ["tab:graph", "tab:chats", "tab:app/x", "tab:notes.md"];
    const state = parseUiState({
      version,
      editorGroups: [{ id: "main", tabs: paths, activeTab: "tab:graph", size: 1 }],
      activeEditorGroup: "main",
    });
    expect(allTabs(state).map(tab => tab.path)).toEqual(paths);
    expect(state.editorGroups[0].activeTab).toBe("tab:graph");
    for (const path of paths) {
      expect(parseTab(path).kind).toBe("file");
    }
    expect(parseUiState(serializeUiState(state))).toEqual(state);
  });

  it("refuses unknown future versions using the existing default-state policy", async () => {
    const future = { ...await fixture(3), version: 4 };
    expect(parseUiState(future)).toEqual(defaultWorkbenchState());
    expect(WorkspaceUiState.safeParse(future).success).toBe(false);
    expect(WorkspaceUiState.safeParse(await fixture(2)).success).toBe(false);
  });
});
