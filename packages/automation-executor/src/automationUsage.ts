import { isDeepStrictEqual } from "node:util";
import type { USAGE_ACTION_IDS } from "@dohc/workspace-contracts/usage";
import type { StoredRun } from "./automationRunStore";

export const AUTOMATION_USAGE_ACTION_IDS = [
  "collection.record.edit", "collection.record.create", "chat.post", "chat.reply", "dataset.operation.invoke",
] as const satisfies readonly (typeof USAGE_ACTION_IDS)[number][];
export type AutomationUsageInvocation = { capabilityId: (typeof AUTOMATION_USAGE_ACTION_IDS)[number]; door: "automation" };

// A completed run counts each capability once, including steps resumed from
// an earlier attempt. savedRunOf in collectionAutomationRun.ts returns a
// completed outcome before execution when the claim already has a done run.
export function automationUsageInvocations(
  run: StoredRun,
  isWriteAction: (effect: Extract<StoredRun["steps"][number]["effects"][number], { kind: "dataset-action" }>) => boolean,
): AutomationUsageInvocation[] {
  const ids = new Set<AutomationUsageInvocation["capabilityId"]>();
  let index = 0;
  for (const step of run.steps) for (const effect of step.effects) {
    const writes = run.applied[index++]?.writes ?? [];
    if (effect.kind === "set" && writes.some(write => write.kind === "field" && !isDeepStrictEqual(write.before, write.after))) {
      ids.add("collection.record.edit");
    } else if (effect.kind === "dataset-edit" && writes.some(write => write.kind === "dataset-edit"
      && write.fields.some(field => !isDeepStrictEqual(field.before, field.after)))) {
      ids.add("collection.record.edit");
    } else if ((effect.kind === "add" && writes.some(write => write.kind === "created"))
      || (effect.kind === "dataset-create" && writes.some(write => write.kind === "dataset-created"))) {
      ids.add("collection.record.create");
    } else if (effect.kind === "message" && writes.some(write => write.kind === "message")) {
      ids.add(effect.to.kind === "group" ? "chat.post" : "chat.reply");
    } else if (effect.kind === "dataset-action" && isWriteAction(effect) && writes.some(write => write.kind === "dataset-action")) {
      ids.add("dataset.operation.invoke");
    }
  }
  return [...ids].map(capabilityId => ({ capabilityId, door: "automation" }));
}
