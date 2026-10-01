import { describe, expect, it } from "vitest";
import { parseAutomationsFile, writeAutomationsFile, type Automation } from "./automations";
import { automationDefinitionList, serializeAutomationSave, serializeAutomationSwitch } from "./automationControls";

const hash = "a".repeat(64);
const source = "version: 1\nautomations:\n  - id: stamp\n    name: Stamp\n    when: record-added\n    do:\n      - set:\n          Title: Ready\n        operation: records.edit\n";
const content = (text = source) => ({ text, contentHash: hash, truncated: false });
const input = { automation: "stamp", enabled: false, expectedContentHash: hash, reformat: true, submitId: "switch-1" };

describe("file-backed automation controls", () => {
  it("lists valid, invalid, on and off definitions without runtime fields", () => {
    const text = `${source}  - id: broken\n    enabled: false\n    when: nonsense\n`;
    const result = automationDefinitionList(content(text), false);
    expect(result.file.status === "read" && result.file.entries.map(entry => [entry.status, entry.enabledInFile])).toEqual([["valid", true], ["invalid", false]]);
    expect(result).not.toHaveProperty("history");
    expect(JSON.stringify(result)).not.toMatch(/lastRun|cannotRun|running|reach/);
  });
  it("switches exactly enabled, preserving pinned bindings and other definitions", async () => {
    const parsed = parseAutomationsFile(source);
    if (parsed.status !== "read") throw new Error("fixture");
    const written = await serializeAutomationSwitch(content(), input);
    if (written.status !== "prepared") throw new Error("fixture");
    const next = parseAutomationsFile(written.text);
    expect(next).toEqual({ status: "read", entries: parsed.entries.map(entry => entry.status === "valid"
      ? { ...entry, automation: { ...entry.automation, enabled: false } } : entry) });
  });
  it("requires formatting consent and a matching base", async () => {
    await expect(serializeAutomationSwitch(content(`# Keep this comment\n${source}`), { ...input, reformat: false })).resolves.toEqual({ status: "reformats" });
    await expect(serializeAutomationSwitch(content(), { ...input, expectedContentHash: "b".repeat(64) })).resolves.toEqual({ status: "conflict" });
  });
  it("refuses broken YAML and unreadable entries without dropping them", async () => {
    for (const text of ["version: [", `${source}  - id: broken\n    when: nonsense\n`]) {
      await expect(serializeAutomationSwitch(content(text), input)).resolves.toEqual({ status: "unreadable" });
    }
  });
  it("checks a pinned owner's save through the same round-trip writer", async () => {
    const parsed = parseAutomationsFile(source);
    if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") throw new Error("fixture");
    const saved = parsed.entries[0].automation;
    const pinOperations = async (automations: readonly Automation[], held: readonly Automation[]) => {
      expect(held).toEqual([saved]); return [...automations];
    };
    const result = await serializeAutomationSave({ current: content(), expectedContentHash: hash, reformat: true, automations: [saved], pinOperations });
    const written = writeAutomationsFile([{ status: "valid", automation: saved }]);
    expect(result).toEqual(written.status === "ok" ? { status: "prepared", text: written.text } : written);
  });
  it("keeps shared personal steps read-only", async () => {
    const personal = "version: 1\nautomations:\n  - id: stamp\n    name: Stamp\n    when: record-added\n    do:\n      - wake-agent: Check\n        person: user_ana\n";
    const file = content(personal);
    const listed = automationDefinitionList(file, true);
    expect(listed.file.status === "read" && listed.file.entries[0]?.canSwitch).toBe(false);
    await expect(serializeAutomationSwitch(file, input)).resolves.toMatchObject({ status: "unavailable", reason: expect.stringContaining("personal step") });
  });
  it("reports a missing file or definition as a changed base", async () => {
    await expect(serializeAutomationSwitch(null, input)).resolves.toEqual({ status: "conflict" });
    await expect(serializeAutomationSwitch(content(), { ...input, automation: "gone" })).resolves.toEqual({ status: "conflict" });
  });
});
