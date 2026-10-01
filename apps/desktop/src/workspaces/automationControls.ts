import { createHash } from "node:crypto";
import { automationDefinitionList, serializeAutomationSwitch, type AutomationDefinitionList, type AutomationFileContent, type AutomationSwitchInput, type AutomationSwitchResult } from "@dohc/workspace-contracts/automation-controls";
import { isNormalizedRelativePath } from "@dohc/workspace-contracts/collection-values";

export type AutomationDeliveryStatus = { contentHash: string | null; state: AutomationDefinitionList["sync"]; reason?: string };
export type AutomationControlsTarget = { collectionPath: string; automation: string };

/** Definition reads and switches use the same file owner for windows and agents. */
export function createAutomationControls(dependencies: {
  resolve(collectionPath: string): Promise<{ content: AutomationFileContent | null; canSwitch: boolean; switchReason?: string; delivery: AutomationDeliveryStatus | null }>;
  write(path: string, text: string, expectedContentHash: string, submitId: string): Promise<Exclude<AutomationSwitchResult, { status: "written" }> | { status: "written"; sync: "accepted" | "pending" }>;
}) {
  const pathOf = (collectionPath: string): string => {
    if (!isNormalizedRelativePath(collectionPath)) throw new Error("Choose a Collection in this workspace.");
    return `${collectionPath}/automations.yaml`;
  };
  return {
    async list(collectionPath: string): Promise<AutomationDefinitionList> {
      pathOf(collectionPath);
      const { content: current, canSwitch, switchReason, delivery } = await dependencies.resolve(collectionPath);
      // A concurrent save invalidates this response's delivery coordinate.
      const sync = delivery === null ? "accepted" : delivery.contentHash === (current?.contentHash ?? null) ? delivery.state : "pending";
      return automationDefinitionList(current, canSwitch, sync, switchReason);
    },
    async switch(collectionPath: string, input: AutomationSwitchInput): Promise<AutomationSwitchResult> {
      const path = pathOf(collectionPath);
      const { content, canSwitch, switchReason } = await dependencies.resolve(collectionPath);
      if (!canSwitch) return { status: "unavailable", reason: switchReason ?? "This share does not allow automation switches." };
      const prepared = await serializeAutomationSwitch(content, input);
      if (prepared.status !== "prepared") return prepared;
      const result = await dependencies.write(path, prepared.text, input.expectedContentHash, input.submitId);
      if (result.status !== "written") return result;
      const hash = createHash("sha256").update(prepared.text).digest("hex");
      return { ...result, contentHash: hash };
    },
  };
}
