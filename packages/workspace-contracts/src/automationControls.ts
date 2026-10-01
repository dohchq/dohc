import { parseAutomationsFile, writeAutomationsFile, type Automation, type AutomationDiagnostic, type AutomationEntry } from "./automations";

export const SHARED_AUTOMATION_HISTORY_REASON = "Run history is unavailable through shares. Each host keeps the runs it made.";
const SHARED_PERSONAL_AUTOMATION_REASON = "This automation has a personal step and cannot be switched through a share.";

export type AutomationFileContent = { text: string; contentHash: string | null; truncated: boolean };
type AutomationSaveRefusal =
  | { status: "conflict" }
  | { status: "unreadable" }
  | { status: "reformats" }
  | { status: "refused"; diagnostics: AutomationDiagnostic[] };
export type AutomationSavePreparation = { status: "prepared"; text: string } | AutomationSaveRefusal;
export type AutomationSwitchInput = {
  automation: string;
  enabled: boolean;
  expectedContentHash: string;
  reformat: boolean;
  /** Links retry with this id and input; desktop saves require a definition reread after unknown. */
  submitId: string;
};
export type AutomationSwitchResult =
  | { status: "written"; contentHash: string; sync: "accepted" | "pending" }
  | AutomationSaveRefusal
  | { status: "unavailable"; reason: string }
  | { status: "unknown"; submitId: string }
  | { status: "refused-write"; reason: string };

/** Definition state only. Reading this file says nothing about execution on a host. */
export type AutomationDefinitionList = {
  file: { status: "read"; entries: Array<AutomationEntry & { enabledInFile: boolean | null; canSwitch: boolean; switchReason?: string }> }
    | { status: "unreadable"; diagnostic: AutomationDiagnostic } | { status: "missing" };
  contentHash: string | null;
  canSwitch: boolean;
  switchReason?: string;
  sync: "accepted" | "pending" | "refused";
};

function hasPersonalStep(automation: Automation): boolean {
  const personal = (steps: Automation["do"]): boolean => steps.some(step => step.kind === "wake-agent"
    || step.kind === "if" && (personal(step.do) || personal(step.otherwise)));
  return personal(automation.do);
}

export function automationDefinitionList(current: AutomationFileContent | null, canSwitch: boolean, sync: AutomationDefinitionList["sync"] = "accepted", switchReason?: string): AutomationDefinitionList {
  const parsed = current === null ? { status: "missing" as const } : current.truncated
    ? { status: "unreadable" as const, diagnostic: { code: "file-too-large" as const, path: "" } }
    : parseAutomationsFile(current.text);
  const readable = parsed.status === "read" && parsed.entries.every(entry => entry.status === "valid");
  return {
    file: parsed.status !== "read" ? parsed : { status: "read", entries: parsed.entries.map(entry => {
      const raw = entry.status === "invalid" && entry.raw instanceof Map ? entry.raw as Map<unknown, unknown> : null;
      const enabled = raw?.get("enabled");
      const personal = entry.status === "valid" && hasPersonalStep(entry.automation);
      return { ...entry, enabledInFile: entry.status === "valid" ? entry.automation.enabled
        : raw && !raw.has("enabled") ? true : typeof enabled === "boolean" ? enabled : null,
        canSwitch: canSwitch && readable && entry.status === "valid" && !personal,
        ...(!canSwitch && switchReason ? { switchReason } : personal ? { switchReason: SHARED_PERSONAL_AUTOMATION_REASON } : {}),
      };
    }) },
    contentHash: current?.contentHash ?? null, canSwitch, sync, ...(switchReason ? { switchReason } : {}),
  };
}

/** The panel and agent saves share base, readability, formatting, and round-trip checks. */
export async function serializeAutomationSave(input: {
  current: AutomationFileContent | null;
  expectedContentHash: string | null;
  reformat: boolean;
  automations: readonly Automation[];
  pinOperations(automations: readonly Automation[], saved: readonly Automation[]): Promise<Automation[]>;
}): Promise<AutomationSavePreparation> {
  if ((input.current?.contentHash ?? null) !== input.expectedContentHash) return { status: "conflict" };
  let saved: Automation[] = [];
  if (input.current) {
    const parsed = parseAutomationsFile(input.current.text);
    if (input.current.truncated || parsed.status !== "read" || parsed.entries.some(entry => entry.status === "invalid")) return { status: "unreadable" };
    const laidOut = writeAutomationsFile(parsed.entries);
    if (!input.reformat && (laidOut.status !== "ok" || laidOut.text !== input.current.text)) return { status: "reformats" };
    saved = parsed.entries.flatMap(entry => entry.status === "valid" ? [entry.automation] : []);
  }
  try {
    const pinned = await input.pinOperations(input.automations, saved);
    const written = writeAutomationsFile(pinned.map(automation => ({ status: "valid", automation })));
    return written.status === "ok" ? { status: "prepared", text: written.text } : written;
  } catch {
    return { status: "refused", diagnostics: [{ code: "changed-on-reread", path: "/automations" }] };
  }
}

/** A switch preserves every existing binding and changes one enabled value. */
export async function serializeAutomationSwitch(current: AutomationFileContent | null, input: AutomationSwitchInput): Promise<AutomationSavePreparation | { status: "unavailable"; reason: string }> {
  if (!current || current.contentHash !== input.expectedContentHash) return { status: "conflict" };
  const parsed = parseAutomationsFile(current.text);
  if (current.truncated || parsed.status !== "read" || parsed.entries.some(entry => entry.status === "invalid")) return { status: "unreadable" };
  const saved = parsed.entries.flatMap(entry => entry.status === "valid" ? [entry.automation] : []);
  const selected = saved.find(automation => automation.id === input.automation);
  if (!selected) return { status: "conflict" };
  if (hasPersonalStep(selected)) return { status: "unavailable", reason: SHARED_PERSONAL_AUTOMATION_REASON };
  return serializeAutomationSave({ current, expectedContentHash: input.expectedContentHash, reformat: input.reformat,
    automations: saved.map(automation => automation.id === input.automation ? { ...automation, enabled: input.enabled } : automation),
    pinOperations: async automations => [...automations],
  });
}
