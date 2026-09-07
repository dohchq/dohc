import type { BrowserWindow as ElectronWindow } from "electron";
import {
  DesktopUserSettingsResult, DesktopMarksResult, LaunchMarksResult,
  OpenExternalUrlPayload, ReloadRendererRequestPayload, SetTitlebarThemePayload,
  StepWindowZoomPayload, WriteClipboardTextPayload,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { isSafeExternalUrl } from "../security/electronSecurity";
import type { DesktopUserSettingsResult as UserSettingsResult, ZoomStep } from "../settings/userSettings";
import type { createQuitGuard, createRecoveryChecker } from "../quitGuard";
import type { rememberChromeTheme as RememberChromeTheme, titleBarOverlayOptions as TitleBarOverlayOptions } from "../window/createMainWindow";

export function createWindowIpc<
  Sender extends { isDestroyed(): boolean; reload(): void },
  Event extends { sender: Sender },
  PaintEvent extends { senderFrame?: { url: string } | null },
>(dependencies: {
  registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
  registerEvent(channel: string, handler: (event: PaintEvent) => void): void;
  assertTrustedSender(event: Event): void;
  prepareForRendererReload(sender: Sender, rendererDocumentId: string): Promise<boolean>;
  shell: { openExternal(url: string): Promise<void> };
  clipboard: { writeText(text: string): void };
  BrowserWindow: { fromWebContents(sender: Sender): Partial<Pick<ElectronWindow, "setTitleBarOverlay">> | null };
  rememberChromeTheme: typeof RememberChromeTheme;
  titleBarOverlayOptions: typeof TitleBarOverlayOptions;
  stepWindowZoom(step: ZoomStep): Promise<UserSettingsResult>;
  recoveryChecker: ReturnType<typeof createRecoveryChecker>;
  quitGuard: ReturnType<typeof createQuitGuard>;
  isTrustedFrame(url: string): boolean;
  launchMarks: Pick<typeof import("../performance/launchMarks").launchMarks, "firstPaint" | "snapshot">;
  desktopMarks: Pick<typeof import("../performance/desktopMarks").desktopMarks, "markOnce" | "snapshot">;
  logLaunchMarksOnce(): void;
  app: { readonly isPackaged: boolean };
}) {
  const {
    registerHandler, registerEvent, assertTrustedSender, prepareForRendererReload,
    shell, clipboard, BrowserWindow, rememberChromeTheme, titleBarOverlayOptions,
    stepWindowZoom, recoveryChecker, quitGuard, isTrustedFrame, launchMarks,
    desktopMarks, logLaunchMarksOnce, app,
  } = dependencies;

  function registerReload(): void {
    registerHandler(CHANNELS.reloadRenderer, async (event, payload) => {
      assertTrustedSender(event);
      const input = ReloadRendererRequestPayload.parse(payload);
      const sender = event.sender;
      const accepted = await prepareForRendererReload(
        sender,
        input.rendererDocumentId,
      );
      if (accepted && !sender.isDestroyed()) sender.reload();
    });
  }

  function registerExternalUrl(): void {
    // The only path from renderer to the OS browser (window.open is a pure
    // deny): http(s) URLs only, used by cloud login's verification step.
    registerHandler(CHANNELS.openExternalUrl, async (event, payload) => {
      assertTrustedSender(event);
      const input = OpenExternalUrlPayload.parse(payload);
      if (!isSafeExternalUrl(input.url)) {
        throw new Error(`Refusing to open non-http(s) URL externally`);
      }
      await shell.openExternal(input.url);
    });
  }

  function registerWindowControls(): void {
    registerHandler(CHANNELS.writeClipboardText, async (event, payload) => {
      assertTrustedSender(event);
      const input = WriteClipboardTextPayload.parse(payload);
      clipboard.writeText(input.text);
    });

    // Theme flip → re-tint the OS window-control overlay. setTitleBarOverlay
    // only exists where the overlay does (Windows, newer Linux); macOS and
    // older Linux feature-detect to a no-op — never a crash.
    registerHandler(CHANNELS.setTitlebarTheme, (event, payload) => {
      assertTrustedSender(event);
      const input = SetTitlebarThemePayload.parse(payload);
      // Persist so the next launch paints the native chrome in this theme
      // before any renderer JS runs (no light flash on dark launches).
      rememberChromeTheme(input.theme);
      const window = BrowserWindow.fromWebContents(event.sender);
      if (!window || typeof window.setTitleBarOverlay !== "function") return;
      try {
        window.setTitleBarOverlay(titleBarOverlayOptions(input.theme));
      } catch {
        // Platform without a title bar overlay: nothing to re-tint.
      }
    });

    // The palette and the Settings stepper share the menu accelerators' zoom
    // mutation; the answer is the settings now on disk, so the caller paints
    // the level actually in effect.
    registerHandler(CHANNELS.stepWindowZoom, async (event, payload) => {
      assertTrustedSender(event);
      const input = StepWindowZoomPayload.parse(payload);
      return DesktopUserSettingsResult.parse(await stepWindowZoom(input.step));
    });
  }

  function registerQuitAndMarks(): void {
    registerHandler(CHANNELS.recoveryCheckAnswer, (event, payload: unknown) => {
      assertTrustedSender(event);
      const answer = payload as { requestId?: unknown; blocked?: unknown };
      if (
        typeof answer?.requestId !== "number" ||
        typeof answer?.blocked !== "boolean"
      ) {
        return;
      }
      recoveryChecker.answer(answer.requestId, answer.blocked);
    });

    registerHandler(CHANNELS.holdQuit, (event) => {
      assertTrustedSender(event);
      // The renderer's recovery dialog owns the decision now; the quit stays
      // cancelled until the user resumes it (or never).
      quitGuard.hold();
    });

    registerHandler(CHANNELS.resumeQuit, (event) => {
      assertTrustedSender(event);
      quitGuard.resume();
    });

    registerEvent(CHANNELS.firstPaint, (event) => {
      if (isTrustedFrame(event.senderFrame?.url ?? "")) {
        launchMarks.firstPaint();
        desktopMarks.markOnce("first-renderer-paint");
        logLaunchMarksOnce();
      }
    });

    // Double-gated: env flag and unpackaged build. A packaged app launched
    // with the env var set must never grow test surface.
    if (process.env.DOHC_DESKTOP_TEST === "1" && !app.isPackaged) {
      registerHandler(CHANNELS.getLaunchMarks, (event) => {
        assertTrustedSender(event);
        return LaunchMarksResult.parse(launchMarks.snapshot());
      });
      registerHandler(CHANNELS.getDesktopMarks, (event) => {
        assertTrustedSender(event);
        return DesktopMarksResult.parse(desktopMarks.snapshot());
      });
    }
  }

  return { registerReload, registerExternalUrl, registerWindowControls, registerQuitAndMarks };
}
