import { expect, it } from "vitest";
import { createPhysicalWorkspaceRemoval, createWorkspaceForget } from "../workspaces/physicalWorkspaceRemoval";
import type { RegistryEntry } from "../workspaces/registryStore";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";
import { RendererWorkspaceSessionOwner } from "./rendererWorkspaceSessionOwner";
import { windowShowsWorkspace } from "./workspaceWindowReuse";

function renderer(id: number) {
  return { id, isDestroyed: () => false, once: () => undefined };
}

const shared = {
  shareId: "share", granterEmail: null, genericChatWritable: false,
  grantedSelector: { paths: ["docs"], versionId: null, access: "view" as const },
};

// Forget leaves the window that showed the workspace. Open folder on the same
// folder registers its workspace again under the same id.
it.each([
  { kind: "a share view", shareView: shared },
  { kind: "an ordinary workspace with no share record", shareView: null },
])("doesn't reuse a window left from before Forget when $kind opens again", async ({ shareView }) => {
  const workspace: RegistryEntry = {
    workspaceId: "workspace", rootPath: "root", kind: "personal", mode: "local-first", ...(shareView ? { shareView } : {}),
  };
  let registered: RegistryEntry | null = null;
  const authorities = createWorkspaceAuthorityOwner({
    findWorkspace: () => registered,
    canonicalizeRoot: path => path,
    createState: () => ({}),
  });
  const register = () => authorities.registerBinding(workspace, {
    persist: () => { registered = workspace; },
    rollback: () => { registered = null; },
  });
  const forget = createWorkspaceForget({
    currentBinding: workspaceId => authorities.currentBinding(workspaceId),
    findWorkspace: () => registered,
    removePhysicalWorkspace: createPhysicalWorkspaceRemoval({
      retireBinding: (binding, retirement) => authorities.retireBinding(binding, retirement),
      findWorkspace: () => registered,
      removeWorkspace: () => { registered = null; },
      removeDrafts: async () => undefined,
      onError: (_workspaceId, error) => { throw error; },
    }),
    trust: { restrict: async () => undefined },
    forgottenShareViews: { remember: async () => undefined },
    clearNotices: () => undefined,
    notifyRenderer: () => undefined,
  });
  const sessions = new RendererWorkspaceSessionOwner<ReturnType<typeof renderer>>({
    retirement: {
      retireSender: () => ({ requiredForAdmission: Promise.resolve(), detachedFromAdmission: Promise.resolve() }),
      retireWorkspace: async () => undefined,
    },
  });
  const view = renderer(1);
  const shows = () => windowShowsWorkspace(sessions.current(view), workspace.workspaceId, authorities);

  await sessions.open(view, register(), "document-1");
  expect(shows()).toBe(true);

  await forget(workspace.workspaceId);
  expect(registered).toBeNull();
  expect(sessions.current(view)?.workspaceId).toBe(workspace.workspaceId);

  register();
  expect(shows()).toBe(false);
});
