import { writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { EMPTY_EXCALIDRAW_DOCUMENT, planDrawingEdit } from "@dohc/excalidraw-scene/agent";
import type { DrawingEdit } from "@dohc/workspace-contracts/drawing";
import { waitForPathMoments } from "./waitForPathMoments";
import { RESTORER, engine, openRealCapture } from "./workspaceEngineCaptureRust.fixture";

const AGENT = {
  actorOriginId: "test-agent",
  attribution: {
    actorKind: "agent" as const,
    onBehalfOf: "local-person",
    depth: 0,
    agentRunId: "run-live",
  },
};

type Opened = Awaited<ReturnType<typeof openRealCapture>>;

async function editNoteAsAgent(opened: Opened, path: string): Promise<void> {
  const editor = new Y.Doc();
  const session = await opened.capture.openYDocSession({
    path,
    contentKind: "plaintext",
    onRemoteUpdate: (update) => Y.applyUpdate(editor, update),
  });
  Y.applyUpdate(editor, session.initialUpdate);
  const vector = Y.encodeStateVector(editor);
  editor.getText("plainText").insert(0, "Agent line\n");
  session.applyLocalUpdate(Y.encodeStateAsUpdate(editor, vector), undefined, AGENT);
  await session.settleNow();
  await session.close();
}

async function editDrawingAsAgent(opened: Opened, path: string): Promise<void> {
  const canvas = new Y.Doc();
  const session = await opened.capture.openYDocSession({
    path,
    contentKind: "scene",
    onRemoteUpdate: (update) => Y.applyUpdate(canvas, update),
  });
  Y.applyUpdate(canvas, session.initialUpdate);
  const edit: DrawingEdit = { add: [{ id: "box", type: "rectangle", x: 0, y: 0 }] };
  const planned = planDrawingEdit(canvas, edit, Date.now());
  if (!("update" in planned) || planned.update === null) throw new Error("no edit");
  Y.applyUpdate(canvas, planned.update);
  session.applyLocalUpdate(planned.update, undefined, AGENT);
  await session.settleNow();
  await session.close();
}

async function undoRun(opened: Opened) {
  const plan = await opened.capture.planUndoAgentRun("run-live");
  return opened.capture.undoAgentRun("run-live", RESTORER, { expectedPlanToken: plan.planToken });
}

it.skipIf(engine.missing)(
  "undoes an agent run's live edits to a note and a drawing once both are closed",
  async () => {
    const opened = await openRealCapture("live-undo", { settleDebounceMs: 60_000 });
    try {
      const note = "# Plan\n\nPerson line\n";
      await writeFile(join(opened.root, "note.md"), note, "utf8");
      await writeFile(join(opened.root, "plan.excalidraw"), EMPTY_EXCALIDRAW_DOCUMENT, "utf8");
      await waitForPathMoments(opened.capture, "note.md", 1);
      await waitForPathMoments(opened.capture, "plan.excalidraw", 1);

      await editNoteAsAgent(opened, "note.md");
      await editDrawingAsAgent(opened, "plan.excalidraw");
      expect(await readFile(join(opened.root, "note.md"), "utf8")).toContain("Agent line");

      const result = await undoRun(opened);
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual([]);
      expect(result.restored.map((item) => item.path).sort()).toEqual([
        "note.md",
        "plan.excalidraw",
      ]);
      expect(await readFile(join(opened.root, "note.md"), "utf8")).toBe(note);
      expect(await readFile(join(opened.root, "plan.excalidraw"), "utf8")).toBe(
        EMPTY_EXCALIDRAW_DOCUMENT,
      );
    } finally {
      await opened.stop();
    }
  },
  60_000,
);

it.skipIf(engine.missing).each([
  {
    when: "before Undo Run starts",
    outcome: {
      skipped: [
        {
          path: "note.md",
          reason: "local-changes",
          detail: "Changed on disk since this agent run.",
        },
      ],
      failed: [],
    },
  },
  {
    when: "as the restore reaches the engine",
    outcome: {
      skipped: [],
      failed: [{ path: "note.md", detail: "Changed on this device since the last saved version." }],
    },
  },
])(
  "refuses to undo an agent run's live note edit over a person's edit on disk $when",
  async ({ when, outcome }) => {
    const opened = await openRealCapture("live-undo-later-edit", { settleDebounceMs: 60_000 });
    try {
      const absolute = join(opened.root, "note.md");
      await writeFile(absolute, "# Plan\n", "utf8");
      await waitForPathMoments(opened.capture, "note.md", 1);
      await editNoteAsAgent(opened, "note.md");
      const plan = await opened.capture.planUndoAgentRun("run-live");
      expect(plan.restorable.map((item) => item.path)).toEqual(["note.md"]);

      const mine = "# Plan\n\nMy own edit\n";
      const atSend = when === "as the restore reaches the engine";
      if (!atSend) await writeFile(absolute, mine, "utf8");
      const result = await opened.capture.undoAgentRun("run-live", RESTORER, {
        expectedPlanToken: plan.planToken,
        hasOtherWindow: () => {
          if (atSend && new Error().stack?.includes("workspaceEngineCaptureLiveStore"))
            writeFileSync(absolute, mine, "utf8");
          return false;
        },
      });
      expect(result).toMatchObject({ restored: [], ...outcome });
      expect(await readFile(absolute, "utf8")).toBe(mine);
    } finally {
      await opened.stop();
    }
  },
  60_000,
);
