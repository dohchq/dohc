import { confirmWords } from "@dohc/interface-words/confirmations";
import { documentWords } from "@dohc/interface-words/documents";
import { choose, type Choice } from "../confirm";

export interface DocumentActionsInput {
  readonly copyMarkdown: () => void;
  readonly rename?: () => void;
  readonly remove?: () => void;
}

/** Android's document menu, in the platform's sheet. iOS shows the same actions in the bar's menu. */
export async function documentActions(actions: DocumentActionsInput): Promise<void> {
  const items: Array<{ choice: Choice; run: () => void }> = [
    { choice: { label: documentWords.copyAsMarkdown }, run: actions.copyMarkdown },
    ...(actions.rename ? [{ choice: { label: documentWords.rename }, run: actions.rename }] : []),
    ...(actions.remove
      ? [{ choice: { label: confirmWords.delete, destructive: true }, run: actions.remove }]
      : []),
  ];
  const chosen = await choose({
    title: documentWords.documentActions,
    options: items.map((i) => i.choice),
  });
  if (chosen !== null) items[chosen]?.run();
}
