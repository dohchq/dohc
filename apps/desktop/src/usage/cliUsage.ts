import {
  APP_PUBLICATION_CAPABILITIES, APP_RESPONSE_CAPABILITIES, CLI_CAPABILITIES, DATASET_CAPABILITIES,
  type CliRequest, type CliResultByVerb,
} from "@dohc/cli/protocol";
import { CAPABILITIES, type CapabilityId } from "@dohc/workspace-contracts/capabilities";
import { USAGE_ACTION_IDS } from "@dohc/workspace-contracts/usage";
import { RENDERER_USAGE_COVERAGE } from "./rendererUsage";
import { AUTOMATION_USAGE_ACTION_IDS } from "@dohc/automation-executor/automation-usage";

type ActionId = (typeof USAGE_ACTION_IDS)[number];
export type CliUsageInvocation = { capabilityId: ActionId; door: "cli" | "mcp" };
// Show and search are reads. Invoke can run a read operation, with no result
// signal distinguishing it from a mutation, so it remains uncovered.
const reads = new Set<CapabilityId>(["chat.show", "chat.search", "dataset.operation.invoke"]);
export const CLI_USAGE_ACTION_IDS = USAGE_ACTION_IDS.filter(id =>
  !reads.has(id) && Object.values(CLI_CAPABILITIES).some(ids => (ids as readonly CapabilityId[]).includes(id)));
const covered = new Set<CapabilityId>(CLI_USAGE_ACTION_IDS);
// MCP also uses fileWrite for app.create and data.import, so its file.write
// count cannot distinguish those capabilities.
const mcpCovered = new Set<CapabilityId>(CLI_USAGE_ACTION_IDS.filter(id => id !== "file.write"));
const automationCovered = new Set<CapabilityId>(AUTOMATION_USAGE_ACTION_IDS);
export const DESKTOP_USAGE_COVERAGE = RENDERER_USAGE_COVERAGE.map(pair => ({ ...pair,
  status: (pair.door === "cli" && covered.has(pair.capabilityId)
    || pair.door === "automation" && automationCovered.has(pair.capabilityId)
    || pair.door === "mcp" && mcpCovered.has(pair.capabilityId)
      && Object.values(CAPABILITIES[pair.capabilityId].mcp).some(tools => Array.isArray(tools) && tools.length > 0))
    ? "covered" as const : pair.status,
}));

// Called only with the dispatcher's validated result. The collector receives
// the aggregate pair, never arguments, content, paths or result objects.
export function cliUsageInvocation(request: CliRequest, result: CliResultByVerb[CliRequest["verb"]]): CliUsageInvocation | null {
  const id = request.verb === "dataset" ? DATASET_CAPABILITIES[request.args.request.action]
    : request.verb === "appPublication" ? APP_PUBLICATION_CAPABILITIES[request.args.request.action]
    : request.verb === "ownerAppResponses" ? APP_RESPONSE_CAPABILITIES[request.args.request.action]
    : CLI_CAPABILITIES[request.verb][0];
  if (!covered.has(id)) return null;
  if (request.door === "mcp" && !mcpCovered.has(id)) return null;
  if ("ok" in result && !result.ok) return null;
  if ("replayed" in result && result.replayed) return null;
  if ("kind" in result && (result.kind === "refused" || result.kind === "partial")) return null;
  if (request.verb === "saveKeptCopy" && (!("status" in result) || result.status !== "saved")) return null;
  if (request.verb === "documentEdit" && (!("changed" in result) || !result.changed)) return null;
  if (request.verb === "automationSwitch" && (!("result" in result) || !result.result
    || typeof result.result !== "object" || !("status" in result.result) || result.result.status !== "written")) return null;
  if (request.verb === "automationPress" && "outcome" in result && result.outcome !== null) return null;
  if ("kind" in result && result.kind === "recovery-prepared" && result.recovery === null) return null;
  if (request.verb === "ownerAppResponses" && (!("items" in result) || !result.items.length
    || result.items.some(item => item.status !== "deleted" && item.status !== "already-absent")
    || !result.items.some(item => item.status === "deleted"))) return null;
  return { capabilityId: id as ActionId, door: request.door ?? "cli" };
}
