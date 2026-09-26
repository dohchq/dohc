import type { CrashReportSendRequest } from "./crashReportStore";

const SEND = 0;
const VIEW = 1;
const CANCEL = 2;

/**
 * Main's own question before a crash report leaves this computer. The
 * renderer can open it but cannot answer it, so only the person sends a
 * report. View report opens the exact text in a text editor and asks again.
 */
export async function confirmCrashReportSend(
  deps: {
    showMessageBox(options: {
      type: "question";
      message: string;
      detail: string;
      buttons: string[];
      defaultId: number;
      cancelId: number;
      noLink: boolean;
    }): Promise<{ response: number }>;
    // Shows the text in the system's text editor.
    openText(text: string): Promise<void>;
  },
  request: CrashReportSendRequest,
): Promise<boolean> {
  const size = new TextEncoder().encode(request.text).byteLength;
  for (;;) {
    const { response } = await deps.showMessageBox({
      type: "question",
      message: `Send this crash report to ${request.host}?`,
      detail: `The report is ${formatSize(size)} of text. View report opens the exact text dohc sends.`,
      buttons: ["Send report", "View report", "Cancel"],
      defaultId: CANCEL,
      cancelId: CANCEL,
      noLink: true,
    });
    if (response === SEND) return true;
    if (response !== VIEW) return false;
    await deps.openText(request.text);
  }
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`;
}
