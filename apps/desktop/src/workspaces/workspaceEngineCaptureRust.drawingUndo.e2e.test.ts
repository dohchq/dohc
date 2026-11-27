import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { EMPTY_EXCALIDRAW_DOCUMENT, planDrawingEdit } from "@dohc/excalidraw-scene/agent";
import type { DrawingEdit } from "@dohc/workspace-contracts/drawing";
import { waitForPathMoments } from "./waitForPathMoments";
import { engine, openRealCapture } from "./workspaceEngineCaptureRust.fixture";

const PATH = "plan.excalidraw";
const PERSON = { actorOriginId: "local-person" };
const AGENT = {
  actorOriginId: "test-agent",
  attribution: {
    actorKind: "agent" as const,
    onBehalfOf: "local-person",
    depth: 0,
    agentRunId: "run-draw",
  },
};

it.skipIf(engine.missing)(
  "credits an agent run's live drawing edit to Undo Run, and skips it while the drawing is open",
  async () => {
    const opened = await openRealCapture("drawing-undo", { settleDebounceMs: 60_000 });
    try {
      await writeFile(join(opened.root, PATH), EMPTY_EXCALIDRAW_DOCUMENT, "utf8");
      await waitForPathMoments(opened.capture, PATH, 1);
      const canvas = new Y.Doc();
      const session = await opened.capture.openYDocSession({
        path: PATH,
        contentKind: "scene",
        onRemoteUpdate: (update) => Y.applyUpdate(canvas, update),
      });
      Y.applyUpdate(canvas, session.initialUpdate);
      const edit = async (input: DrawingEdit, options: typeof PERSON) => {
        const planned = planDrawingEdit(canvas, input, Date.now());
        if (!("update" in planned) || planned.update === null) throw new Error("no edit");
        Y.applyUpdate(canvas, planned.update);
        session.applyLocalUpdate(planned.update, undefined, options);
        await session.settleNow();
      };
      await edit({ add: [{ id: "box", type: "rectangle", x: 0, y: 0 }] }, PERSON);
      await edit({ update: [{ id: "box", expectedVersion: 1, x: 300 }] }, AGENT);
      expect(JSON.parse(await readFile(join(opened.root, PATH), "utf8")).elements).toMatchObject([
        { id: "box", x: 300, version: 2 },
      ]);

      const open = await opened.capture.planUndoAgentRun("run-draw");
      expect(open.restorable).toEqual([]);
      expect(open.skipped.map((item) => [item.path, item.reason])).toEqual([
        [PATH, "live-editing"],
      ]);

      await session.close();
      const history = await opened.capture.listMoments({ limit: 1 });
      expect(history.moments[0]).toMatchObject({
        path: PATH,
        metadata: { origin: "ydoc" },
        authors: [{ kind: "agent", agentRunId: "run-draw" }],
      });
      const closed = await opened.capture.planUndoAgentRun("run-draw");
      expect(closed.skipped).toEqual([]);
      expect(closed.restorable.map((item) => [item.path, item.action])).toEqual([
        [PATH, "restore"],
      ]);
    } finally {
      await opened.stop();
    }
  },
  60_000,
);
