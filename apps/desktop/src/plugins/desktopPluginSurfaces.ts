import { CHANNELS } from "../ipc/channels";
import {
  PluginPanelInvalidatedEvent,
  PluginWebAppFailedEvent,
} from "../ipc/bridgeContract";
import type {
  RendererWorkspaceSender,
  RendererWorkspaceSessionOwner,
} from "../window/rendererWorkspaceSessionOwner";
import type { WorkspaceAuthorityBinding } from "../workspaces/workspaceAuthorityOwner";
import type { GuestWebPreferences } from "./pluginWebAppGuest";
import type { PluginWorkspaceRuntimes } from "./pluginWorkspaceRuntimes";
import {
  PluginSurfaces,
  type PluginWebAppContainer,
  type PluginWebAppViewLike,
} from "./pluginSurfaces";

interface DesktopPluginSender extends RendererWorkspaceSender {
  send(channel: string, value: unknown): void;
}

interface DesktopPluginWindow<View> {
  isDestroyed(): boolean;
  contentView: {
    addChildView(view: View): void;
    removeChildView(view: View): void;
  };
}

export function createDesktopPluginSurfaces<
  Sender extends DesktopPluginSender,
  View extends PluginWebAppViewLike,
>(dependencies: {
  BrowserWindow: {
    fromWebContents(sender: Sender): DesktopPluginWindow<View> | null;
  };
  WebContentsView: new (options: { webPreferences: GuestWebPreferences }) => View;
  webContents: { fromId(senderId: number): Sender | undefined };
  session: {
    defaultSession: { clearStorageData(options: { origin: string }): Promise<void> };
    fromPartition(partition: string): { clearStorageData(): Promise<void> };
  };
  bindGuestZoom(webContents: View["webContents"]): void;
  allowLoopbackFrameOrigin(url: string): () => void;
  withWorkspaceAttachment(
    workspace: { workspaceId: string; attachmentId?: symbol },
    work: () => void,
  ): void;
  readonly rendererWorkspaceSessions: Pick<RendererWorkspaceSessionOwner<Sender>, "current">;
}) {
  const {
    BrowserWindow, WebContentsView, webContents, session, bindGuestZoom,
    allowLoopbackFrameOrigin, withWorkspaceAttachment,
  } = dependencies;

  function createPluginWebAppContainer(
    sender: Sender,
  ): PluginWebAppContainer<View> {
    let attachedWindow: DesktopPluginWindow<View> | null = null;
    return {
      isDestroyed: () => {
        const window = attachedWindow ?? BrowserWindow.fromWebContents(sender);
        return !window || window.isDestroyed();
      },
      attach: (view) => {
        const window = BrowserWindow.fromWebContents(sender);
        if (!window || window.isDestroyed()) {
          throw new Error("The plugin web app request has no open window.");
        }
        attachedWindow = window;
        window.contentView.addChildView(view);
      },
      detach: (view) => {
        const window = attachedWindow;
        attachedWindow = null;
        if (!window || window.isDestroyed()) return;
        window.contentView.removeChildView(view);
      },
    };
  }

  // Tells one renderer its guest died after the start already answered "ok".
  // Without it the page keeps a `ready` state over an empty frame and the user
  // sees a blank tab with nothing to act on. The event carries no failure text:
  // the load error can embed the start URL, credential fragment included.
  //
  // generation gates this the same way every other send in this file does
  // (round-13 finding 3): WebContents ids recycle across a crash-reload, so
  // a sender resolved by a stale id — or a captured reference whose renderer
  // has since reloaded — could otherwise deliver a dead guest's failure to
  // whatever unrelated page now answers to that id or generation.
  function notifyPluginWebAppFailed(
    sender: Sender,
    generation: number,
    event: PluginWebAppFailedEvent,
  ): void {
    if (
      sender.isDestroyed() ||
      dependencies.rendererWorkspaceSessions.current(sender)?.generation !== generation
    ) {
      return;
    }
    sender.send(CHANNELS.pluginWebAppFailed, PluginWebAppFailedEvent.parse(event));
  }

  function notifyPluginPanelInvalidated(
    sender: Sender,
    generation: number,
    event: PluginPanelInvalidatedEvent,
  ): void {
    if (
      sender.isDestroyed() ||
      dependencies.rendererWorkspaceSessions.current(sender)?.generation !== generation
    ) {
      return;
    }
    sender.send(
      CHANNELS.pluginPanelInvalidated,
      PluginPanelInvalidatedEvent.parse(event),
    );
  }

  function createPluginSurfaces<
    Workspace extends { workspaceId: string; rootPath: string },
  >(
    binding: WorkspaceAuthorityBinding<Workspace>,
    pluginRuntimes: PluginWorkspaceRuntimes<Workspace>,
  ): PluginSurfaces<View> {
    return new PluginSurfaces<View>({
      ViewClass: WebContentsView,
      bindWebAppZoom: bindGuestZoom,
      allowPanelOrigin: allowLoopbackFrameOrigin,
      clearPanelStorage: (options) =>
        session.defaultSession.clearStorageData(options),
      clearGuestPartition: (partition) =>
        session.fromPartition(partition).clearStorageData(),
      notifyWebAppFailed: ({ senderId, generation, ...event }) => {
        const sender = webContents.fromId(senderId);
        if (!sender) return;
        withWorkspaceAttachment(
          {
            workspaceId: binding.workspaceId,
            attachmentId: binding.attachmentId,
          },
          () => notifyPluginWebAppFailed(sender, generation, event),
        );
      },
      notifyPanelInvalidated: ({ senderId, generation, ...event }) => {
        const sender = webContents.fromId(senderId);
        if (!sender) return;
        withWorkspaceAttachment(
          {
            workspaceId: binding.workspaceId,
            attachmentId: binding.attachmentId,
          },
          () => notifyPluginPanelInvalidated(sender, generation, event),
        );
      },
      onPanelDisposed: ({ workspaceId, pluginId, panelId, surfaceId }) => {
        pluginRuntimes.current(workspaceId)?.workspaceEvents.disposeOwner({
          kind: "panel",
          workspaceId,
          pluginId,
          panelId,
          surfaceId,
        });
      },
      onError: (error, context) => {
        console.warn(`[desktop] ${context}`, error);
      },
    });
  }

  return { createPluginWebAppContainer, createPluginSurfaces };
}
