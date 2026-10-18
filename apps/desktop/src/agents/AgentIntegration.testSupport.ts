import type { ActiveAgentRun } from "./activeAgentRun";
import {
  AgentIntegrationState,
  createAgentIntegration,
  type AgentIntegrationOptions,
} from "./AgentIntegration";

type InMemoryAgentIntegrationOptions = Omit<
  AgentIntegrationOptions,
  "acquire" | "workspaceIds" | "localPersonId" | "installId"
> & {
  localPersonId?: () => string;
  installId?: () => string;
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
    installId: () => "install-local",
    ...options,
    workspaceIds: () => [...states.keys()],
    acquire: (workspaceId) => {
      const rootPath = options.rootFor(workspaceId);
      if (!rootPath) throw new Error("This workspace was closed. Open it again.");
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
