import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createShareDirectWriteDelivery } from "../ipc/shareDirectWriteDelivery";
import { createPhysicalWorkspaceRemoval, createWorkspaceForget } from "../workspaces/physicalWorkspaceRemoval";
import type { RegistryEntry } from "../workspaces/registryStore";
import { createWorkspaceAuthorityOwner } from "../workspaces/workspaceAuthorityOwner";
import { RendererWorkspaceSessionOwner } from "./rendererWorkspaceSessionOwner";
import { currentWindowSession, oldWindowState, windowShowsWorkspace } from "./workspaceWindowReuse";

function renderer(id: number) {
  let destroyed = false;
  const sent: unknown[] = [];
  return {
    id, sent, isDestroyed: () => destroyed, once: () => undefined, on: () => undefined,
    send: (_channel: string, event: unknown) => { sent.push(event); }, destroy: () => { destroyed = true; },
  };
}

const shared = {
  shareId: "share", granterEmail: null, genericChatWritable: false,
  grantedSelector: { paths: ["docs"], versionId: null, access: "view" as const },
};

// One workspace, its window, and Forget. Open folder on the same folder
// registers its workspace again under the same id.
async function shownWorkspace(shareView: typeof shared | null) {
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
  await sessions.open(view, register(), "document-1");
  return {
    workspace, authorities, sessions, view, register,
    forget: () => forget(workspace.workspaceId),
    isRegistered: () => registered !== null,
  };
}

it.each([
  { kind: "a share view", shareView: shared },
  { kind: "an ordinary workspace with no share record", shareView: null },
])("doesn't count a window left from before Forget as showing $kind after it opens again", async ({ shareView }) => {
  const { workspace, authorities, sessions, view, register, forget, isRegistered } = await shownWorkspace(shareView);
  const shows = () => windowShowsWorkspace(sessions.current(view), workspace.workspaceId, authorities);
  expect(shows()).toBe(true);

  await forget();
  expect(isRegistered()).toBe(false);
  expect(sessions.current(view)?.workspaceId).toBe(workspace.workspaceId);

  const binding = register();
  expect(shows()).toBe(false);

  // The folder opens in a new window. Only that window shows the workspace,
  // so an action there that needs the workspace's only window isn't refused.
  const reopened = renderer(2);
  await sessions.open(reopened, binding, "document-2");
  expect([view, reopened].filter(window =>
    windowShowsWorkspace(sessions.current(window), workspace.workspaceId, authorities))).toEqual([reopened]);
});

it("says whether another window shows the workspace a window was left with after Forget", async () => {
  const { workspace, authorities, sessions, view, register, forget } = await shownWorkspace(null);
  const reopened = renderer(2);
  const stateOf = (window: ReturnType<typeof renderer>) => oldWindowState(
    sessions.current(window),
    [view, reopened].filter(other => other !== window),
    other => sessions.current(other),
    authorities,
  );
  expect(stateOf(view)).toBeNull();

  await forget();
  expect(stateOf(view)).toEqual({ workspaceId: workspace.workspaceId, shownIn: undefined });

  await sessions.open(reopened, register(), "document-2");
  expect(stateOf(view)).toEqual({ workspaceId: workspace.workspaceId, shownIn: reopened });
  expect(stateOf(reopened)).toBeNull();

  reopened.destroy();
  expect(stateOf(view)).toEqual({ workspaceId: workspace.workspaceId, shownIn: undefined });
});

it("has no old window state for a window that shows no workspace", () => {
  expect(oldWindowState(undefined, [], () => undefined, { isCurrentAttachment: () => false })).toBeNull();
});

it("offers a change that couldn't be saved to the reopened share's window, not the one left from before Forget", async () => {
  const { workspace, authorities, sessions, view, register, forget } = await shownWorkspace(shared);
  const reopened = renderer(2);
  const delivery = createShareDirectWriteDelivery({
    targets: () => [view, reopened],
    currentSession: sender => currentWindowSession(sessions.current(sender), authorities),
    isSharedView: () => true,
  });
  const listener = (rendererDocumentId: string) => ({ workspaceId: workspace.workspaceId, rendererDocumentId, subscriptionId: randomUUID() });
  const old = listener("document-1");
  expect(delivery.update(view, { action: "listen", listening: true, ...old })).toBe(true);

  await forget();
  await sessions.open(reopened, register(), "document-2");
  const current = listener("document-2");
  expect(delivery.update(reopened, { action: "listen", listening: true, ...current })).toBe(true);
  delivery.report(workspace.workspaceId, { status: "unavailable" });

  expect(view.sent).toEqual([]);
  const answerId = (reopened.sent[0] as { answerId: string }).answerId;
  // The old window can't take it first.
  expect(delivery.update(view, { action: "claim", answerId, ...old })).toBe(false);
  expect(delivery.update(reopened, { action: "claim", answerId, ...current })).toBe(true);
});
