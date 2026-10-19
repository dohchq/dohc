import { isEditorMenuCommand, type EditorMenuCommand } from "../../ipc/channels";

// Edit > Find reaches the editor that has focus as a DOM event from the
// focused element, so the shell does not load the editor to send it. With
// focus outside every editor, nothing listens and the command does nothing.
const EDITOR_MENU_COMMAND_EVENT = "dohc-editor-menu-command";

export function sendToFocusedEditor(command: EditorMenuCommand): void {
  document.activeElement?.dispatchEvent(
    new CustomEvent(EDITOR_MENU_COMMAND_EVENT, { bubbles: true, detail: command }),
  );
}

// `scope` is the whole editor, including its find bar.
export function onEditorMenuCommand(
  scope: HTMLElement,
  run: (command: EditorMenuCommand) => void,
): () => void {
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent) || !isEditorMenuCommand(event.detail)) return;
    event.stopPropagation();
    run(event.detail);
  };
  scope.addEventListener(EDITOR_MENU_COMMAND_EVENT, listener);
  return () => scope.removeEventListener(EDITOR_MENU_COMMAND_EVENT, listener);
}
