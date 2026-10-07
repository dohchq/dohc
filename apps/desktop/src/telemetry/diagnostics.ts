import { DIAGNOSTICS_MAX_CHARS, type ReportKinds } from "../ipc/bridgeContract";
import type { CrashFacts } from "../crashReports/crashReport";
import type { PrivacySettings } from "../settings/userSettings";

/**
 * What a person can read, copy, or save to help someone find a problem:
 * this build and computer, the report switches, and the crash report main
 * keeps. It holds only what the crash report already allows, and no
 * install ID or engine identity.
 */
export function diagnosticsText(input: {
  facts: CrashFacts;
  // The services this launch can send to.
  available: ReportKinds;
  privacy: PrivacySettings;
  // The crash report's text, or null when nothing is waiting.
  crashReport: string | null;
}): string {
  const { facts } = input;
  const state = (available: boolean, on: boolean) => !available ? "unavailable for this launch" : on ? "on" : "off";
  const text = [
    "dohc diagnostics",
    `Created: ${new Date(facts.atMs).toISOString()}`,
    `Version: ${facts.version} (${facts.channel}${facts.packaged ? "" : ", development build"})`,
    `System: ${facts.system} ${facts.arch}`,
    `Electron: ${facts.electron}`,
    `Running for: ${facts.uptimeSeconds} s`,
    `Usage reports: ${state(input.available.usage, input.privacy.usageReports)}`,
    `Error reports: ${state(input.available.errors, input.privacy.errorReports)}`,
    "",
    input.crashReport ?? "Recent problems: none",
  ].join("\n");
  return text.length > DIAGNOSTICS_MAX_CHARS ? `${text.slice(0, DIAGNOSTICS_MAX_CHARS - 1)}…` : text;
}

/** Asks where to save, then writes the text there. False when cancelled. */
export async function saveDiagnostics(
  deps: {
    showSaveDialog(options: {
      title: string;
      defaultPath: string;
      filters: Array<{ name: string; extensions: string[] }>;
    }): Promise<{ canceled: boolean; filePath?: string }>;
    writeFile(path: string, text: string): Promise<void>;
    defaultPath: string;
  },
  text: string,
): Promise<boolean> {
  const { canceled, filePath } = await deps.showSaveDialog({
    title: "Save diagnostics",
    defaultPath: deps.defaultPath,
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (canceled || !filePath) return false;
  await deps.writeFile(filePath, text);
  return true;
}
