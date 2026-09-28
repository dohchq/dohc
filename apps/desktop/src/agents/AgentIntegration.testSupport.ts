import type { ActiveAgentRun } from "../workspaces/workspaceWatcher";
import {
  AgentIntegrationState,
  createAgentIntegration,
  type AgentIntegrationOptions,
} from "./AgentIntegration";

type InMemoryAgentIntegrationOptions = Omit<
  AgentIntegrationOptions,
  "acquire" | "workspaceIds" | "localPersonId"
> & {
  localPersonId?: () => string;
  rootFor(workspaceId: string): string | null;
  setAgentRun(
    workspaceId: string,
    run: ActiveAgentRun | null,
  ): void | Promise<void>;
};

/** Test-only authority adapter for AgentIntegration's attachment-owned state. */
export function createInMemoryAgentIntegration(
  options: InMemoryAgentIntegrationOptions,
) {
  const states = new Map<string, AgentIntegrationState>();
  return createAgentIntegration({
    localPersonId: () => "person-local",
    ...options,
    workspaceIds: () => [...states.keys()],
    acquire: (workspaceId) => {
      const rootPath = options.rootFor(workspaceId);
      if (!rootPath) throw new Error(`Unknown workspace: ${workspaceId}`);
      let state = states.get(workspaceId);
      if (!state) {
        state = new AgentIntegrationState();
        states.set(workspaceId, state);
      }
      return {
        attachmentId: Symbol.for(`test-workspace-attachment:${workspaceId}`),
        workspaceId,
        rootPath,
        state,
        assertCurrent: () => undefined,
        setAgentRun: (run) => options.setAgentRun(workspaceId, run),
        release: () => undefined,
      };
    },
  });
}
