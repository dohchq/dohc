import { isTemporaryMacAppPath } from "./agents/dohcMcpCommand";

const MOVE = 0;

/**
 * Offers once to move a packaged macOS dohc that runs outside Applications,
 * such as from its disk image or Downloads. Electron's move asks nothing
 * itself: this question is the person's only say. A decline is remembered.
 * After a move, Electron quits dohc and opens the moved copy.
 */
export async function offerMoveToApplications(deps: {
  bundlePath: string;
  isInApplicationsFolder(): boolean;
  declined(): boolean;
  recordDecline(): void;
  // Whether Applications already holds an app of this bundle's name.
  replacesCopy(): boolean;
  showMessageBox(options: {
    type: "question";
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    noLink: boolean;
  }): Promise<{ response: number }>;
  move(): void;
  reportMoveFailure(error: unknown): Promise<void>;
}): Promise<void> {
  if (deps.isInApplicationsFolder() || deps.declined()) return;
  const { response } = await deps.showMessageBox({
    type: "question",
    message: "Move dohc to Applications?",
    detail: [
      ...(isTemporaryMacAppPath(deps.bundlePath) ? ["dohc is running from a disk image or a temporary copy."] : []),
      "dohc moves itself to Applications and opens again.",
      ...(deps.replacesCopy() ? ["It replaces the copy of dohc already there."] : []),
    ].join(" "),
    buttons: ["Move to Applications", "Don't move"],
    defaultId: MOVE,
    cancelId: 1,
    noLink: true,
  });
  if (response !== MOVE) {
    deps.recordDecline();
    return;
  }
  try {
    deps.move();
  } catch (error) {
    await deps.reportMoveFailure(error);
  }
}
