import { DevForgetWorkspacesResult, DevRevealPathPayload } from "./bridgeContract";
import { CHANNELS } from "./channels";

// The debug panel's main-side actions. Double-gated like the test bridge:
// DOHC_DEV_TOOLS=1 and an unpackaged build. A packaged app launched with
// the env var set must never grow this surface.
export function devToolsEnabled(env: NodeJS.ProcessEnv, app: { readonly isPackaged: boolean }): boolean {
  return env.DOHC_DEV_TOOLS === "1" && !app.isPackaged;
}

// Main's decision reaches the preload as a process argument, so the renderer
// shows the panel only when main also registered its channels. The preload
// never reads the env var: a packaged app with it set gets no panel.
const DEV_TOOLS_ARGUMENT = "--dohc-dev-tools";

export function devToolsPreloadArguments(enabled: boolean): string[] {
  return enabled ? [DEV_TOOLS_ARGUMENT] : [];
}

export function devToolsGranted(argv: readonly string[]): boolean {
  return argv.includes(DEV_TOOLS_ARGUMENT);
}

export function registerDevToolsIpcHandlers<Event>(dependencies: {
  enabled: boolean;
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  assertTrustedSender(event: Event): void;
  listWorkspaces(): Array<{ workspaceId: string; rootPath: string }>;
  // Retires every open binding for the workspace, then removes the registry
  // row. The folder on disk is left alone.
  forgetWorkspace(workspaceId: string): Promise<void>;
  stateDir(): string;
  showItemInFolder(path: string): void;
}): void {
  const {
    enabled, registerHandler, assertTrustedSender, listWorkspaces, forgetWorkspace,
    stateDir, showItemInFolder,
  } = dependencies;
  if (!enabled) return;

  registerHandler(CHANNELS.devForgetWorkspaces, async (event) => {
    assertTrustedSender(event);
    const workspaces = listWorkspaces();
    for (const workspace of workspaces) await forgetWorkspace(workspace.workspaceId);
    return DevForgetWorkspacesResult.parse({ forgot: workspaces.length });
  });

  registerHandler(CHANNELS.devRevealPath, (event, payload) => {
    assertTrustedSender(event);
    const input = DevRevealPathPayload.parse(payload);
    if (input.target === "state-dir") {
      showItemInFolder(stateDir());
      return;
    }
    const workspace = listWorkspaces().find((entry) => entry.workspaceId === input.workspaceId);
    if (!workspace) throw new Error("That workspace is not in the registry.");
    showItemInFolder(workspace.rootPath);
  });
}
