// A page edited live (liveAdapter.ts). The page shows the text the app read until the provider is live, then the live
// document replaces it in one paint. It takes edits only while live.
import { exceedsLiveMarkdownLimit } from "@dohc/live-session-contract/limits";
import type { FieldDefinition } from "@dohc/workspace-contracts/collection";
import { validateFieldValue } from "@dohc/workspace-contracts/collection-values";
import { yDocToMarkdown } from "@dohc/ydoc-projection";
import { mountLiveBodyEditor } from "@dohc/ydoc-projection/browser-editor";
import { readsBodySequence } from "@dohc/ydoc-projection/body-sequence-yjs";
import { frontmatterEditsRefused } from "@dohc/ydoc-projection/frontmatter";
import { patchFrontmatter } from "@dohc/ydoc-projection/frontmatter-map";
import * as Y from "yjs";
import { post } from "./bridge";
import { isHiddenPropertyKey } from "./document";
import { opensFormat, refuseFormat } from "./format";
import { createLiveAdapter, type LiveProvider } from "./liveAdapter";
import type { EditorToolbar } from "./toolbar";

export function applyCheckedFrontmatterPatch(
  doc: Y.Doc,
  key: string,
  value: unknown,
  field: FieldDefinition | undefined,
):
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly reason: "refused" | "invalid" } {
  if (
    typeof key !== "string" ||
    !key.trim() ||
    isHiddenPropertyKey(key, field) ||
    frontmatterEditsRefused(doc)
  )
    return { ok: false, reason: "refused" };
  const normalized = typeof value === "number" && Object.is(value, -0) ? 0 : value;
  if (
    field &&
    (field.type === "button" || validateFieldValue(field, normalized).status !== "valid")
  )
    return { ok: false, reason: "invalid" };
  const probe = new Y.Doc();
  try {
    Y.applyUpdate(probe, Y.encodeStateAsUpdate(doc));
    patchFrontmatter(probe, new Map([[key, normalized]]));
    if (exceedsLiveMarkdownLimit(yDocToMarkdown(probe))) return { ok: false, reason: "refused" };
  } catch {
    return { ok: false, reason: "refused" };
  } finally {
    probe.destroy();
  }
  let changed = false;
  const mark = () => {
    changed = true;
  };
  doc.on("update", mark);
  try {
    patchFrontmatter(doc, new Map([[key, normalized]]));
  } catch {
    return { ok: false, reason: "refused" };
  } finally {
    doc.off("update", mark);
  }
  return { ok: true, changed };
}

export function followLive(input: {
  /** The read text's body, which the live one replaces. */
  readonly body: HTMLElement;
  readonly readOnly: { destroy(): void };
  readonly label: string;
  readonly toolbar?: EditorToolbar;
  readonly onPropertiesDoc?: (doc: Y.Doc | null) => void;
  readonly getPropertyField?: (key: string) => FieldDefinition | undefined;
  endEditing(): void;
}) {
  let shown: LiveProvider | null = null;
  let host: HTMLDivElement | null = null;
  let wasLive = false;
  let refused = false;
  let editor: ReturnType<typeof mountLiveBodyEditor> | null = null;
  let unobserveProps: (() => void) | null = null;
  let pendingSave: { readonly requestId: string | undefined; readonly key: string } | null = null;

  const failPending = (reason: "refused" | "not-live") => {
    if (!pendingSave) return;
    const failed = pendingSave;
    pendingSave = null;
    post("propertyError", { requestId: failed.requestId, reason });
  };

  function refuse() {
    refused = true;
    failPending("refused");
    unobserveProps?.();
    unobserveProps = null;
    input.onPropertiesDoc?.(null);
    input.endEditing();
    input.toolbar?.detach();
    editor?.destroy();
    editor = null;
    refuseFormat();
  }

  function show(made: LiveProvider) {
    failPending("not-live");
    shown = made;
    if (!opensFormat(made.doc)) {
      refuse();
      return;
    }
    const first = !host;
    const next = host ?? document.createElement("div");
    host = next;
    if (first) {
      next.className = input.body.className;
      next.hidden = true;
      input.body.after(next);
    }
    const takesEdits = () => !refused && shown === made && made.state().status === "live";
    let sequence = readsBodySequence(made.doc);
    const mount = () => {
      const mounted = mountLiveBodyEditor(next, {
        doc: made.doc,
        label: input.label,
        canEdit: takesEdits,
        edit(change) {
          if (!takesEdits()) return false;
          change();
          return true;
        },
        unwritten: (why) => why !== "guarded" && post("unwritten", { why }),
      });
      input.toolbar?.attach(mounted, takesEdits);
      return mounted;
    };
    editor?.destroy();
    editor = mount();
    unobserveProps?.();
    const frontmatter = made.doc.getMap("frontmatter");
    const meta = made.doc.getMap("meta");
    const refreshProps = () => {
      if (!refused && shown === made) input.onPropertiesDoc?.(made.doc);
    };
    frontmatter.observeDeep(refreshProps);
    meta.observe(refreshProps);
    unobserveProps = () => {
      frontmatter.unobserveDeep(refreshProps);
      meta.unobserve(refreshProps);
    };
    refreshProps();
    made.doc.on("update", () => {
      if (refused || shown !== made) return;
      if (!opensFormat(made.doc)) return refuse();
      if (readsBodySequence(made.doc) === sequence) return;
      sequence = !sequence;
      editor?.destroy();
      editor = mount();
    });
    const settlePending = () => {
      if (!pendingSave || shown !== made) return;
      const state = made.state();
      if (state.status === "live" && state.pendingUpdates === 0) {
        const done = pendingSave;
        pendingSave = null;
        post("propertySaved", { requestId: done.requestId, key: done.key });
      } else if (state.status === "quarantined" || state.status === "closed") {
        failPending("refused");
      }
    };
    made.subscribe(() => {
      if (shown !== made) return;
      editor?.refresh();
      input.toolbar?.refresh();
      refreshProps();
      settlePending();
    });
    (window as Window & { __dohcCopyMarkdown?: () => void }).__dohcCopyMarkdown = () =>
      post("markdown", { markdown: yDocToMarkdown(made.doc) });
    (
      window as Window & {
        __dohcPatchFrontmatter?: (payload: {
          key: string;
          value: unknown;
          requestId?: string;
        }) => void;
      }
    ).__dohcPatchFrontmatter = ({ key, value, requestId }) => {
      if (!takesEdits()) return post("propertyError", { requestId, reason: "not-live" });
      failPending("not-live");
      const applied = applyCheckedFrontmatterPatch(
        made.doc,
        key,
        value,
        input.getPropertyField?.(key),
      );
      if (!applied.ok) return post("propertyError", { requestId, reason: applied.reason });
      if (!applied.changed) return post("propertySaved", { requestId, key });
      pendingSave = { requestId, key };
      settlePending();
    };
    // Swapped once the live editor has drawn, so the read text never leaves an empty frame.
    if (first)
      requestAnimationFrame(() =>
        setTimeout(() => {
          if (refused) return;
          input.body.remove();
          input.readOnly.destroy();
          next.hidden = false;
        }, 0),
      );
  }

  const adapter = createLiveAdapter({
    post: (message) => post(message.kind, message),
    changed(made) {
      if (refused) return;
      const live = made.state().status === "live";
      if (live && shown !== made) show(made);
      // Editing stops at once when the page isn't live: the caret goes, and the keyboard with it.
      if (wasLive && !live) input.endEditing();
      wasLive = live;
    },
  });
  (window as Window & { __dohcLive?: (message: unknown) => void }).__dohcLive = adapter.receive;
}
