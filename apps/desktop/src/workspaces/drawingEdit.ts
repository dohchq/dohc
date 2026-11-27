import { randomUUID } from "node:crypto";
import { EXCALIDRAW_EXPORTABLE_APP_STATE, foldScene } from "@dohc/excalidraw-scene";
import {
  EMPTY_EXCALIDRAW_DOCUMENT,
  planDrawingEdit,
  summarizeDrawing,
  type PlannedDrawingEdit,
} from "@dohc/excalidraw-scene/agent";
import type {
  DrawingEdit,
  DrawingElementInput,
  DrawingReadResult,
  DrawingWriteResult,
} from "@dohc/workspace-contracts/drawing";
import { YdocOwnerDraftPendingError } from "@dohc/workspace-engine-client";
import type { z } from "zod";
import * as Y from "yjs";
import {
  DOCUMENT_EDIT_PENDING_WARNING,
  LiveDocumentEditAppliedError,
  type LiveDocumentEditOrigin,
  type LiveDocumentSessions,
} from "./engineYDocSessionIpc";

type DrawingWrite = z.output<typeof DrawingWriteResult>;

export async function editDrawing(
  sessions: LiveDocumentSessions,
  input: { workspaceId: string; path: string; edit: DrawingEdit; origin: LiveDocumentEditOrigin },
): Promise<DrawingWrite> {
  let opened = false;
  const edited = sessions.editLiveDocument(
    { workspaceId: input.workspaceId, path: input.path, kind: "scene" },
    async (provider, path, session): Promise<DrawingWrite> => {
      opened = true;
      const settleNow = provider.settleNow;
      if (!settleNow) throw new Error(`${path} cannot take an edit from here.`);
      const decided: { plan?: PlannedDrawingEdit | { reason: string } } = {};
      const accepted = await provider.applyDecidedLocalUpdate(
        (doc) => {
          session.assertSame();
          const plan = planDrawingEdit(doc, input.edit, Date.now());
          decided.plan = plan;
          return "reason" in plan ? null : plan.update;
        },
        undefined,
        { ...input.origin, idempotencyKey: randomUUID() },
      );
      const plan = decided.plan!;
      if ("reason" in plan) return { ok: false, reason: plan.reason };
      const elements = plan.written.map(({ id, version }) => ({ id, version }));
      if (plan.update === null) return { ok: true, path, elements };
      if (!accepted) throw new Error(`The engine did not accept the edit to ${path}.`);
      session.show(plan.update);
      let warning: string | undefined;
      try {
        await settleNow.call(provider);
      } catch (error) {
        if (!(error instanceof YdocOwnerDraftPendingError)) {
          const cause = error instanceof Error ? error.message : String(error);
          throw new LiveDocumentEditAppliedError(
            `The edit is in ${path}, but dohc has not saved it to the file yet (${cause}). Read the drawing before you retry.`,
            { cause: error },
          );
        }
        warning = DOCUMENT_EDIT_PENDING_WARNING;
      }
      const winners = new Map(foldScene(provider.doc).elements.map((each) => [each.id, each]));
      const lost = plan.written.filter(({ id, version, versionNonce }) => {
        const winner = winners.get(id);
        return winner?.version !== version || winner.versionNonce !== versionNonce;
      });
      if (lost.length > 0) {
        throw new LiveDocumentEditAppliedError(
          `Someone changed ${lost.map(({ id }) => id).join(", ")} at the same moment, so that part of this edit is not in ${path}. Read the drawing again and redo what is missing.`,
        );
      }
      return { ok: true, path, elements, ...(warning ? { warning } : {}) };
    },
  );
  const { result } = await edited.catch((error: unknown) => {
    throw !opened && error instanceof Error && error.message === "invalid-input"
      ? new Error(
          `${input.path} is not saved in Excalidraw's own format, so dohc could not open it to edit. Open and save it in Excalidraw, or give each element an id and a type, each text element its text, and each embedded file its id, mimeType, dataURL, and created time.`,
          { cause: error },
        )
      : error;
  });
  return result;
}

export async function createDrawing(
  sessions: LiveDocumentSessions,
  input: {
    workspaceId: string;
    path: string;
    elements: DrawingElementInput[];
    origin: LiveDocumentEditOrigin;
  },
  writeNewFile: (text: string) => Promise<void>,
): Promise<DrawingWrite> {
  const refused = planDrawingEdit(new Y.Doc(), { add: input.elements }, 0);
  if ("reason" in refused) return { ok: false, reason: refused.reason };
  await writeNewFile(EMPTY_EXCALIDRAW_DOCUMENT);
  if (input.elements.length === 0) return { ok: true, path: input.path, elements: [] };
  try {
    return await editDrawing(sessions, { ...input, edit: { add: input.elements } });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new LiveDocumentEditAppliedError(
      `dohc created ${input.path}, but could not add its elements (${cause}). Read the drawing, then edit it to add what is missing.`,
      { cause: error },
    );
  }
}

export async function readDrawing(
  sessions: LiveDocumentSessions,
  input: { workspaceId: string; path: string; points?: boolean },
  settledText: (path: string) => Promise<string>,
): Promise<DrawingReadResult> {
  const { path, state } = await sessions.readDocument({ ...input, kind: "scene" });
  const points = input.points === true;
  if (state) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const scene = foldScene(doc);
    return {
      path,
      live: true,
      elements: summarizeDrawing(scene.elements, points),
      appState: scene.appState,
    };
  }
  const text = await settledText(path);
  let file: unknown = {};
  try {
    if (text.trim() !== "") file = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not a valid drawing file.`);
  }
  if (text.trim() !== "" && (file as { type?: unknown } | null)?.type !== "excalidraw")
    throw new Error(`${path} is not an Excalidraw drawing.`);
  const { elements, appState } = (file ?? {}) as { elements?: unknown; appState?: unknown };
  return {
    path,
    live: false,
    elements: summarizeDrawing(Array.isArray(elements) ? elements : [], points),
    appState: Object.fromEntries(
      EXCALIDRAW_EXPORTABLE_APP_STATE.flatMap((key) => {
        const value = (appState as Record<string, unknown> | null | undefined)?.[key];
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  };
}
