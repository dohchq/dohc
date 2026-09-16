import type { Node, ResolvedPos } from "@tiptap/pm/model";
import { Plugin, type PluginSpec } from "@tiptap/pm/state";
import type { AutocompleteState } from "./wikilinkPlugin";

export function makeTriggerPlugin<State>(
  spec: PluginSpec<State> & { view?: never },
  detect: (doc: Node, cursorPos: number, position?: ResolvedPos) => AutocompleteState,
  onChange: (state: AutocompleteState) => void,
): Plugin<State> {
  let last: AutocompleteState = { active: false };
  function notify(next: AutocompleteState): void {
    if (next.active && last.active) {
      if (next.from === last.from && next.query === last.query) return;
    } else if (!next.active && !last.active) {
      return;
    }
    last = next;
    onChange(next);
  }
  return new Plugin({
    ...spec,
    view(view) {
      const recompute = () => notify(detect(view.state.doc, view.state.selection.from, view.state.selection.$from));
      recompute();
      return {
        update: (_view, previous) => {
          if (previous.doc !== view.state.doc || previous.selection.from !== view.state.selection.from) recompute();
        },
        destroy: () => notify({ active: false }),
      };
    },
  });
}
