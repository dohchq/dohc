import { describe, expect, it } from "vitest";
import { confirmCrashReportSend } from "./crashReportConsent";

const REQUEST = { host: "reports.example.test", text: "dohc crash report\n\nProcess: main" };

function answering(...responses: number[]) {
  const asked: { message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number }[] = [];
  const opened: string[] = [];
  return {
    asked,
    opened,
    deps: {
      showMessageBox: async (options: (typeof asked)[number]) => {
        asked.push(options);
        return { response: responses.shift() ?? 2 };
      },
      openText: async (text: string) => {
        opened.push(text);
      },
    },
  };
}

describe("main's crash report dialog", () => {
  it("names where the report goes and its size, and defaults to Cancel", async () => {
    const dialog = answering(2);
    expect(await confirmCrashReportSend(dialog.deps, REQUEST)).toBe(false);
    expect(dialog.asked).toEqual([expect.objectContaining({
      message: "Send this crash report to reports.example.test?",
      detail: "The report is 32 bytes of text. View report opens the exact text dohc sends.",
      buttons: ["Send report", "View report", "Cancel"],
      defaultId: 2,
      cancelId: 2,
    })]);
  });

  it("opens the exact text, asks again, and sends only on Send report", async () => {
    const dialog = answering(1, 0);
    expect(await confirmCrashReportSend(dialog.deps, REQUEST)).toBe(true);
    expect(dialog.opened).toEqual([REQUEST.text]);
    expect(dialog.asked).toHaveLength(2);
  });
});
