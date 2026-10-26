// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { bindDocPresence } from "./docPresence";
vi.mock("./docPresence", { spy: true });
import { bindExcalidrawPresence } from "./excalidrawPresence";
import { setOwnPresentation } from "../workbench/actorPresentation";
import { setChosenColors } from "../workbench/chosenColors";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
afterEach(() => { delete document.documentElement.dataset.theme; setChosenColors(DEFAULT_USER_SETTINGS); setOwnPresentation(undefined); });
it("leaves collaborator colours to Excalidraw without publishing user overrides", async () => {
  const localDoc = new Y.Doc(); const remoteDoc = new Y.Doc(); const awareness = new Awareness(remoteDoc);
  awareness.setLocalState({ pointer: { x: 1, y: 2, tool: "pointer" } });
  const update = Buffer.from(encodeAwarenessUpdate(awareness, [awareness.clientID])).toString("base64");
  const updateScene = vi.fn();
  const published: unknown[] = [];
  setChosenColors({ ...DEFAULT_USER_SETTINGS, appearance: { ...DEFAULT_USER_SETTINGS.appearance, yourColor: "blue" } });
  const binding = bindExcalidrawPresence({ doc: localDoc, clientId: "irrelevant", displayName: "You", topic: "scene",
    getApi: () => ({ updateScene }) as unknown as ExcalidrawImperativeAPI,
    transport: {
      async publish({ state }) { published.push(state); return { version: 1, peers: [{ faceToken: "face", sessionToken: "session", isSelf: false, displayName: "Remote", paletteSlot: 4, state: { yc: awareness.clientID, update }, updatedAtMs: 0 }] }; },
      async leave() {},
      poll: ({ signal }) => new Promise(resolve => signal.addEventListener("abort", () => resolve({ version: 1, peers: [] }), { once: true })),
    },
  });
  const collaborator = () => [...updateScene.mock.calls.at(-1)![0].collaborators.values()][0];
  try {
    await expect.poll(collaborator).toMatchObject({ username: "Remote" });
    expect(collaborator()).not.toHaveProperty("color");
    // No unsupported local colour is put into awareness.
    expect(published.length).toBeGreaterThan(0);
    const local = vi.mocked(bindDocPresence).mock.results.at(-1)!.value;
    expect(local.awareness.getLocalState()?.user).not.toHaveProperty("color");
    const calls = updateScene.mock.calls.length;
    document.documentElement.dataset.theme = "dark";
    await Promise.resolve();
    expect(updateScene).toHaveBeenCalledTimes(calls);
    setOwnPresentation({ group: "own", hue: "rose", self: true });
    setChosenColors(DEFAULT_USER_SETTINGS);
    expect(local.awareness.getLocalState()?.user).not.toHaveProperty("color");
    expect(updateScene).toHaveBeenCalledTimes(calls);
  } finally { await binding.destroy(); awareness.destroy(); localDoc.destroy(); remoteDoc.destroy(); }
});
