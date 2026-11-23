import type { Node, ResolvedPos } from "@tiptap/pm/model";
import {
  Plugin,
  PluginKey,
  type EditorState,
  type PluginSpec,
  type Transaction,
} from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { AutocompleteState } from "./wikilinkPlugin";

const triggerDismissMeta = new PluginKey<number>("dohc-trigger-dismiss");

export function dismissTrigger(view: EditorView, from: number): void {
  if (typeof view.dispatch !== "function" || !view.state) return;
  view.dispatch(view.state.tr.setMeta(triggerDismissMeta, from).setMeta("addToHistory", false));
}

export function makeTriggerPlugin<State>(
  spec: PluginSpec<State> & { view?: never },
  detect: (doc: Node, cursorPos: number, position?: ResolvedPos) => AutocompleteState,
  onChange: (state: AutocompleteState) => void,
): Plugin<State> {
  let last: AutocompleteState = { active: false };
  let dismissedFrom: number | null = null;
  let dismissedDirty = false;

  function notify(next: AutocompleteState): void {
    if (next.active && last.active) {
      if (next.from === last.from && next.query === last.query) return;
    } else if (!next.active && !last.active) {
      return;
    }
    last = next;
    onChange(next);
  }

  function updateDismissed(tr: Transaction): void {
    const dismissAt = tr.getMeta(triggerDismissMeta) as number | undefined;
    if (typeof dismissAt === "number") {
      if (last.active && last.from === dismissAt) {
        dismissedFrom = dismissAt;
        dismissedDirty = true;
      }
      return;
    }
    if (dismissedFrom !== null && tr.docChanged) {
      const mapped = tr.mapping.mapResult(dismissedFrom);
      dismissedFrom = mapped.deleted ? null : mapped.pos;
    }
  }

  const wrappedState = spec.state
    ? {
        init: spec.state.init,
        apply(tr: Transaction, value: State, oldState: EditorState, newState: EditorState) {
          updateDismissed(tr);
          return spec.state!.apply(tr, value, oldState, newState);
        },
      }
    : {
        init: () => undefined as unknown as State,
        apply(tr: Transaction) {
          updateDismissed(tr);
          return undefined as unknown as State;
        },
      };

  return new Plugin({
    ...spec,
    state: wrappedState,
    view(view) {
      const recompute = () => {
        dismissedDirty = false;
        const detected = detect(
          view.state.doc,
          view.state.selection.from,
          view.state.selection.$from,
        );
        if (!detected.active) {
          dismissedFrom = null;
          notify(detected);
          return;
        }
        if (dismissedFrom !== null && detected.from === dismissedFrom) {
          notify({ active: false });
          return;
        }
        dismissedFrom = null;
        notify(detected);
      };
      recompute();
      return {
        update: (_view, previous) => {
          if (
            dismissedDirty ||
            previous.doc !== view.state.doc ||
            previous.selection.from !== view.state.selection.from
          )
            recompute();
        },
        destroy: () => {
          dismissedFrom = null;
          notify({ active: false });
        },
      };
    },
  });
}
