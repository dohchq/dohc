export async function projectChatBookmarksAfterPull(input: {
  readOnly: boolean;
  project: () => Promise<void>;
  reportError: (error: unknown) => void;
}): Promise<void> {
  // Projection writes generated Markdown into the workspace. Shared views may
  // ingest their filtered relay state, but must never materialize personal
  // bookmark files into that read-only tree.
  if (input.readOnly) return;
  try {
    await input.project();
  } catch (error) {
    input.reportError(error);
  }
}
