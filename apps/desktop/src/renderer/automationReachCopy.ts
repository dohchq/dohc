import type { CollectionAutomationHold } from "../automations/collectionAutomations";

export function automationReachCopy(
  step: Pick<CollectionAutomationHold, "action" | "target">,
  permission = false,
): string {
  switch (step.action) {
    case "find": return `${permission ? "view" : "find records in"} ${step.target}`;
    case "change": return `${permission ? "edit" : "change"} ${step.target}`;
    case "post": return `post in ${step.target}`;
    case "wake": return `wake ${step.target}`;
    case "notify": return `notify ${step.target}`;
  }
}
