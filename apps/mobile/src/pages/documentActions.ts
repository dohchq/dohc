import { documentWords } from "@dohc/interface-words/documents";
import { choose } from "../confirm";

/** Android's document menu, in the platform's sheet. iOS shows the same action in the bar's menu. */
export async function documentActions(copyMarkdown: () => void): Promise<void> {
  const chosen = await choose({
    title: documentWords.documentActions,
    options: [{ label: documentWords.copyAsMarkdown }],
  });
  if (chosen === 0) copyMarkdown();
}
