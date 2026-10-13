// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { bindDocPresence } from "./docPresence";
vi.mock("./docPresence", { spy: true });
import { bindExcalidrawPresence } from "./excalidrawPresence";
import { identityHues } from "../tokens";
import { setChosenColors } from "../workbench/chosenColors";
import { DEFAULT_USER_SETTINGS } from "../../settings/userSettings";
afterEach(() => { delete document.documentElement.dataset.theme; setChosenColors(DEFAULT_USER_SETTINGS.appearance); });
it("uses disclosed drawing slots, the own colour and repaints on a theme change", async () => {
  const localDoc = new Y.Doc(); const remoteDoc = new Y.Doc(); const awareness = new Awareness(remoteDoc);
  awareness.setLocalState({ pointer: { x: 1, y: 2, tool: "pointer" } });
  const update = Buffer.from(encodeAwarenessUpdate(awareness, [awareness.clientID])).toString("base64");
  const updateScene = vi.fn();
  const published: unknown[] = [];
  setChosenColors({ ...DEFAULT_USER_SETTINGS.appearance, yourColor: "blue" });
  const binding = bindExcalidrawPresence({ doc: localDoc, clientId: "irrelevant", displayName: "You", topic: "scene",
    getApi: () => ({ updateScene }) as unknown as ExcalidrawImperativeAPI,
    transport: {
      async publish({ state }) { published.push(state); return { version: 1, peers: [{ faceToken: "face", sessionToken: "session", isSelf: false, displayName: "Remote", paletteSlot: 4, state: { yc: awareness.clientID, update }, updatedAtMs: 0 }] }; },
      async leave() {},
      poll: ({ signal }) => new Promise(resolve => signal.addEventListener("abort", () => resolve({ version: 1, peers: [] }), { once: true })),
    },
  });
  const stroke = () => [...updateScene.mock.calls.at(-1)![0].collaborators.values()][0]?.color.stroke;
  try {
    await expect.poll(stroke).toBe(identityHues.light.indigo);
    // The local user colour exists only in local awareness, never in publication.
    expect(published.length).toBeGreaterThan(0);
    const local = vi.mocked(bindDocPresence).mock.results.at(-1)!.value;
    expect(local.awareness.getLocalState()?.user.color).toBe(identityHues.light.blue);
    document.documentElement.dataset.theme = "dark";
    await expect.poll(stroke).toBe(identityHues.dark.indigo);
    expect(local.awareness.getLocalState()?.user.color).toBe(identityHues.dark.blue);
  } finally { await binding.destroy(); awareness.destroy(); localDoc.destroy(); remoteDoc.destroy(); }
});
