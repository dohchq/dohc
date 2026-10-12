import { CAPABILITIES } from "@dohc/workspace-contracts/capabilities";
import { MCP_TOOL_CAPABILITIES } from "./tools";

const MCP_ACCESS_LEVELS = ["owner", "view", "comment", "edit"] as const;
type McpAccessLevel = typeof MCP_ACCESS_LEVELS[number];

export function deriveMcpToolLevels<Tool extends string, Id extends string>(
  tools: Readonly<Record<Tool, readonly Id[]>>,
  capabilities: Readonly<Record<Id, {
    readonly mcp: Readonly<Record<McpAccessLevel, readonly string[]>>;
  }>>,
): Record<Tool, readonly McpAccessLevel[]> {
  const levels = {} as Record<Tool, readonly McpAccessLevel[]>;
  for (const name of Object.keys(tools) as Tool[]) {
    levels[name] = MCP_ACCESS_LEVELS.filter(level => {
      const offered = tools[name].map(id => capabilities[id].mcp[level].includes(name));
      if (offered.some(value => value !== offered[0])) {
        throw new Error(`MCP capability ids disagree for ${name} at ${level}`);
      }
      return offered.length > 0 && offered.every(Boolean);
    });
  }
  return levels;
}

// Validate every level at module load, before any server can advertise a tool.
export const MCP_TOOL_LEVELS = deriveMcpToolLevels(MCP_TOOL_CAPABILITIES, CAPABILITIES);
