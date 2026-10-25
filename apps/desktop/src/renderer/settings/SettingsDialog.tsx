import { shortcutKeys } from "../../shortcuts/shortcutRegistry";
import { desktopPins, settingsSectionPin } from "../../testPins";
import { useRequestSequence } from "../useRequestSequence";
import { CopyField } from "../ui/CopyButton";
import { SkeletonRows } from "../ui/SkeletonRows";
import { StateMark } from "../ui/StateMark";
import { AlertTriangle, RefreshCw, X } from "lucide-react";
import { WORKSPACE_PREVIEW_MODES } from "@dohc/workspace-contracts/workspace-settings-values";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_SIDEBAR_SETTINGS,
  DEFAULT_USER_SETTINGS,
  EDITOR_FONTS,
  type DesktopUserSettingsResult,
  MAX_EDITOR_FONT_SIZE,
  MAX_ZOOM_LEVEL,
  MIN_EDITOR_FONT_SIZE,
  MIN_ZOOM_LEVEL,
  type DesktopUserSettings,
  firstAgent,
  newAgentDefaults,
  withAgent,
  withFirstAgent,
  zoomPercent,
} from "../../settings/userSettings";
import {
  ATTACHMENT_FOLDER_NAME_MAX_LENGTH,
  DEFAULT_WORKSPACE_SETTINGS,
  mergeWorkspaceSettings,
  type WorkspaceSettings,
  type WorkspaceSettingsPatch,
  type WorkspaceSettingsResult,
} from "../../workspaces/workspaceSettings";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { requestGuardedUpdateInstall } from "../RecoveryCloseGuard";
import { applyLookSettings } from "../theme";
import { palette } from "../tokens";
import { ChatAvatar } from "../workbench/ChatAvatar";
import { ownPresentation, ownAgentPresentation } from "../workbench/actorPresentation";
import { useDesktopUpdateStateFeed } from "../useDesktopUpdateStateFeed";
import { AskAgentButton, type AskAgent } from "../askAgent";
import { AgentsMcpSettings } from "./AgentsMcpSettings";
import { CloudSyncSettings, type CloudSettings } from "./CloudSyncSettings";
import type { CustomizeTarget } from "./customize";
import { KeyboardSettings } from "./KeyboardSettings";
import { PreferredNameControl } from "./PreferredNameControl";
import { ScheduleHostRow } from "./ScheduleHostRow";
import {
  ColorControl,
  HueControl,
  SettingRow,
  SettingsSection,
  StepperControl,
  SwitchControl,
  TextControl,
  ThemeControl,
} from "./SettingRow";
import { SettingsNav } from "./SettingsNav";
import { ReportsSettings } from "./ReportsSettings";
import { UsageRecordSettings } from "./UsageRecordSettings";
import { SegmentedControl } from "../ui/SegmentedControl";
import { useWorkspaceTrust } from "../useWorkspaceTrust";
import type { SharingFocus } from "../workbench/SharingView";
import { SharingSearchResults, useSharingSearch } from "./SharingSearchResults";
import { SidebarViewsControl } from "./SidebarViewsControl";
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "./settingsRegistry";

export type SettingsSaveState = "idle" | "saving" | "saved" | "error";

function sectionMatches(section: (typeof SETTINGS_SECTIONS)[number], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [section.id, section.label, section.scope, ...section.keywords]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

function isModified(value: unknown, defaultValue: unknown): boolean {
  // Settings schemas are strict serializable POJOs, so stable stringify is enough
  // for reset badges without pulling a deep-equality helper into preload-bound code.
  return JSON.stringify(value) !== JSON.stringify(defaultValue);
}

// The document chip's "your edits are still here" is false here: a failed
// save goes back to the settings the file holds.
export const SETTINGS_SAVE_ERROR_TITLE =
  "dohc could not save this setting. Try changing it again.";

function StatusPill(props: { state: SettingsSaveState }) {
  if (props.state === "idle") return null;
  return (
    <StateMark
      testId="settings-save-state"
      state={props.state}
      shown={props.state}
      title={props.state === "error" ? SETTINGS_SAVE_ERROR_TITLE : undefined}
      className="ml-auto"
    />
  );
}

export function SettingsDialog(props: {
  onError?: (message: string, cause?: unknown, retry?: () => Promise<void>) => void;
  /** Each workspace settings answer, so the shell can say what the file ignored. */
  onWorkspaceSettingsRead?: (read: WorkspaceSettingsResult) => void;
  workspaceId: string;
  workspaceIsReady: boolean;
  workspaceOpenFailed?: boolean;
  workspacePath: string;
  /**
   * True when this workspace is a shared view. See the Advanced
   * section: the engine toggle asserts a choice and a recording that a
   * shared view never has.
   */
  sharedView?: boolean;
  /**
   * Main's open-time recorder decision for this workspace, undefined
   * until its status arrives. The engine setting lives here, so this surface
   * owes the recovery that actually works — and the two off states have
   * different ones. See the runner note in `RunnerSettingsCard`.
   */
  sessionRecorderOn?: boolean;
  initialSection?: SettingsSectionId;
  // The part a Customize… command opened Settings for: its row is marked and
  // takes focus.
  focus?: CustomizeTarget;
  // Hands a settings change to the person's agent. Absent while chats are off.
  askAgent?: AskAgent;
  onClose: () => void;
  /** The shell's server connection for this workspace, for Sync and sharing. */
  cloud?: CloudSettings;
  /** Closes Settings and opens the Sharing view on a lane or a share search found. */
  onOpenSharing?: (target: SharingFocus) => void;
  /**
   * Opens this workspace's live documents. Owned workspaces only: a shared
   * view runs no owner live delivery, so it has no such list to manage.
   */
  onOpenLiveDocuments?: () => void;
}) {
  const { onWorkspaceSettingsRead } = props;
  // A shared view never runs app code, so it has no trust to change.
  const workspaceTrust = useWorkspaceTrust(props.workspaceId, props.workspaceIsReady && !props.sharedView);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const userSaveRequestRef = useRequestSequence();
  const workspaceSaveRequestRef = useRequestSequence();
  // Workspace identity token. The request-id refs above only order responses
  // within one workspace; they say nothing about which workspace a response
  // belongs to. This is bumped whenever props.workspaceId changes, and every
  // workspace-scoped response (load, save, reset) is dropped unless the token it
  // captured still matches — so a slow response for workspace A can never repaint
  // (or, via the next full-settings save, overwrite) workspace B. Mirrors the
  // token guard DesktopWorkspaceShell uses for engine history.
  const workspaceTokenRef = useRequestSequence();
  // A zoom broadcast arriving while the initial Promise.all load is in flight
  // is newer than the user-settings snapshot that load retained, and must not
  // be painted over.
  const settingsEventFiredRef = useRef(false);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(
    props.initialSection ?? DEFAULT_SETTINGS_SECTION,
  );
  const [query, setQuery] = useState("");
  const [userResult, setUserResult] = useState<DesktopUserSettingsResult | null>(null);
  const [workspaceResult, setWorkspaceResult] =
    useState<WorkspaceSettingsResult | null>(null);
  const [saveState, setSaveState] = useState<SettingsSaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = useState<"check" | "install" | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const { updateState, acceptUpdateResult } =
    useDesktopUpdateStateFeed(() => setUpdateError(null));
  const saveStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workspaceWritesRef = useRef<{
    save: (patch: WorkspaceSettingsPatch) => Promise<void>;
    reset: () => Promise<void>;
  }>({ save: async () => undefined, reset: async () => undefined });
  const [settingsFilePath, setSettingsFilePath] = useState<string | null>(null);

  const clearSaveStateTimer = useCallback(() => {
    if (saveStateTimerRef.current) {
      clearTimeout(saveStateTimerRef.current);
      saveStateTimerRef.current = null;
    }
  }, []);

  const markSaving = useCallback(() => {
    clearSaveStateTimer();
    setSaveState("saving");
  }, [clearSaveStateTimer]);

  const markSaved = useCallback(() => {
    clearSaveStateTimer();
    setSaveState("saved");
    saveStateTimerRef.current = setTimeout(() => {
      saveStateTimerRef.current = null;
      setSaveState((current) => (current === "saved" ? "idle" : current));
    }, 1200);
  }, [clearSaveStateTimer]);

  useEffect(() => {
    const row = props.focus
      ? dialogRef.current?.querySelector<HTMLElement>(`[data-testid="${props.focus.row}"]`)
      : null;
    if (!row) {
      closeRef.current?.focus();
      return;
    }
    row.focus({ preventScroll: true });
    row.scrollIntoView?.({ block: "center" });
  }, []);

  useEffect(() => () => clearSaveStateTimer(), [clearSaveStateTimer]);

  useEffect(() => {
    let active = true;
    void bridge()
      .getUserSettingsFilePath()
      .then((path) => {
        if (active) setSettingsFilePath(path);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const openSettingsFile = useCallback(async () => {
    try {
      await bridge().openUserSettingsFile();
    } catch (cause) {
      props.onError?.(ipcErrorMessage(cause, "dohc could not open the settings file."));
    }
  }, [props.onError]);

  useEffect(
    () =>
      bridge().onUserSettingsChanged((result) => {
        settingsEventFiredRef.current = true;
        // A broadcast is newer than any request still in flight: bumping the
        // request counter drops those pending responses, so an older save's
        // answer cannot overwrite this result. The write behind the broadcast
        // already succeeded, so the saved state is honest.
        userSaveRequestRef.next();
        setUserResult(result);
        markSaved();
      }),
    [markSaved],
  );

  useEffect(() => {
    if (props.initialSection) setActiveSection(props.initialSection);
  }, [props.initialSection]);

  useEffect(() => {
    let cancelled = false;
    // New workspace → new token, and drop the previous workspace's settings.
    // Holding on to them would let a control edited before the new workspace's
    // settings arrive merge workspace A's values into a save aimed at B; with no
    // result, saveWorkspaceSettings refuses ("still loading") instead.
    const token = workspaceTokenRef.next();
    settingsEventFiredRef.current = false;
    setWorkspaceResult(null);
    void Promise.all([
      bridge().getUserSettings(),
      props.workspaceIsReady ? bridge().getWorkspaceSettings({ workspaceId: props.workspaceId }) : undefined,
    ])
      .then(([nextUser, nextWorkspace]) => {
        if (cancelled) return;
        // The window already shows these settings: DesktopRoot applies each
        // read and each change. Applying this read again could undo a change
        // that arrived while it was in flight.
        if (!settingsEventFiredRef.current) setUserResult(nextUser);
        if (!workspaceTokenRef.isCurrent(token) || !nextWorkspace) return;
        setWorkspaceResult(nextWorkspace);
        onWorkspaceSettingsRead?.(nextWorkspace);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(ipcErrorMessage(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.workspaceId, props.workspaceIsReady]);

  const filteredSections = useMemo(
    () => SETTINGS_SECTIONS.filter((section) => sectionMatches(section, query)),
    [query],
  );
  const sharingResults = useSharingSearch(props.workspaceId, !!props.sharedView, props.workspaceIsReady && props.onOpenSharing ? query : "");

  useEffect(() => {
    if (
      query.trim() &&
      !filteredSections.some((section) => section.id === activeSection) &&
      filteredSections[0]
    ) {
      setActiveSection(filteredSections[0].id);
    }
  }, [activeSection, filteredSections, query]);

  const saveUserSettings = useCallback(async (settings: DesktopUserSettings) => {
    if (!userResult) {
      setError("User settings are still loading.");
      return;
    }
    const requestId = userSaveRequestRef.next();
    const previous = userResult;
    setUserResult((current) => ({
      settings,
      source: current?.source ?? "default",
      ...(current?.warning ? { warning: current.warning } : {}),
    }));
    applyLookSettings(settings);
    markSaving();
    setError(null);
    try {
      const saved = await bridge().setUserSettings({ settings, base: previous.settings });
      if (!userSaveRequestRef.isCurrent(requestId)) return;
      setUserResult(saved);
      markSaved();
    } catch (cause) {
      if (!userSaveRequestRef.isCurrent(requestId)) return;
      setSaveState("error");
      setError(ipcErrorMessage(cause));
      props.onError?.(ipcErrorMessage(cause, "dohc could not save your settings."), cause);
      // `previous` can hold a change an earlier save failed to make, so the
      // dialog goes back to the settings the file holds.
      const restored = await bridge().getUserSettings().catch(() => previous);
      if (!userSaveRequestRef.isCurrent(requestId)) return;
      setUserResult(restored);
      applyLookSettings(restored.settings);
    }
  }, [markSaved, markSaving, props.onError, userResult]);

  // Takes the changed controls, not the whole file. Main merges them onto the
  // settings on disk, so an edit made outside this dialog (or a file the user
  // repaired after a refusal) survives the next save. The merge here is only
  // the optimistic paint.
  const saveWorkspaceSettings = useCallback(
    async (patch: WorkspaceSettingsPatch) => {
      if (!workspaceResult) {
        setError("Workspace settings are still loading.");
        return;
      }
      const requestId = workspaceSaveRequestRef.next();
      // Capture the workspace this save belongs to. Everything after the await
      // is only allowed to touch state if we are still on that workspace.
      const token = workspaceTokenRef.current();
      const previous = workspaceResult;
      setWorkspaceResult((current) => ({
        settings: mergeWorkspaceSettings(
          current?.settings ?? DEFAULT_WORKSPACE_SETTINGS,
          patch,
        ),
        source: current?.source ?? "default",
        ...(current?.warning ? { warning: current.warning } : {}),
      }));
      markSaving();
      setError(null);
      try {
        const saved = await bridge().setWorkspaceSettings({
          workspaceId: props.workspaceId,
          patch,
        });
        if (
          !workspaceTokenRef.isCurrent(token) ||
          !workspaceSaveRequestRef.isCurrent(requestId)
        ) {
          return;
        }
        // A refusal means main wrote nothing: it holds the settings file dohc
        // could not read. Take main's answer — the controls snap back to what
        // is really on disk — and never say "Saved".
        setWorkspaceResult(saved);
        onWorkspaceSettingsRead?.(saved);
        if (saved.refusal) setSaveState("error");
        else markSaved();
      } catch (cause) {
        if (
          !workspaceTokenRef.isCurrent(token) ||
          !workspaceSaveRequestRef.isCurrent(requestId)
        ) {
          return;
        }
        setWorkspaceResult(previous);
        setSaveState("error");
        setError(ipcErrorMessage(cause));
        props.onError?.(
          ipcErrorMessage(cause, "dohc could not save this workspace's settings."),
          cause,
          () => workspaceWritesRef.current.save(patch),
        );
      }
    },
    [markSaved, markSaving, onWorkspaceSettingsRead, props.onError, props.workspaceId, workspaceResult],
  );

  // Zoom goes through main's one serialized mutation instead of a full-file
  // save: main persists the level before re-tinting the windows, and its
  // answer is the settings now on disk, so the row paints the level actually
  // in effect.
  const stepZoomSetting = useCallback(async (step: "in" | "out" | "reset") => {
    const requestId = userSaveRequestRef.next();
    markSaving();
    setError(null);
    try {
      const saved = await bridge().stepWindowZoom({ step });
      if (!userSaveRequestRef.isCurrent(requestId)) return;
      setUserResult(saved);
      markSaved();
    } catch (cause) {
      if (!userSaveRequestRef.isCurrent(requestId)) return;
      setSaveState("error");
      // The refusal names the file and the way out.
      setError(ipcErrorMessage(cause));
    }
  }, [markSaved, markSaving]);

  const resetUserSettings = useCallback(async () => {
    const requestId = userSaveRequestRef.next();
    markSaving();
    setError(null);
    try {
      const next = await bridge().resetUserSettings();
      if (!userSaveRequestRef.isCurrent(requestId)) return;
      setUserResult(next);
      applyLookSettings(next.settings);
      markSaved();
    } catch (cause) {
      if (!userSaveRequestRef.isCurrent(requestId)) return;
      setSaveState("error");
      setError(ipcErrorMessage(cause));
      props.onError?.(ipcErrorMessage(cause, "dohc could not reset your settings."), cause);
    }
  }, [markSaved, markSaving, props.onError]);

  const resetWorkspaceSettings = useCallback(async () => {
    const requestId = workspaceSaveRequestRef.next();
    const token = workspaceTokenRef.current();
    markSaving();
    setError(null);
    try {
      const next = await bridge().resetWorkspaceSettings({
        workspaceId: props.workspaceId,
      });
      if (
        !workspaceTokenRef.isCurrent(token) ||
        !workspaceSaveRequestRef.isCurrent(requestId)
      ) {
        return;
      }
      setWorkspaceResult(next);
      onWorkspaceSettingsRead?.(next);
      markSaved();
    } catch (cause) {
      if (
        !workspaceTokenRef.isCurrent(token) ||
        !workspaceSaveRequestRef.isCurrent(requestId)
      ) {
        return;
      }
      setSaveState("error");
      setError(ipcErrorMessage(cause));
      props.onError?.(
        ipcErrorMessage(cause, "dohc could not reset this workspace's settings."),
        cause,
        () => workspaceWritesRef.current.reset(),
      );
    }
  }, [markSaved, markSaving, onWorkspaceSettingsRead, props.onError, props.workspaceId]);
  // Try again runs the save or reset this dialog would run now, so a retried
  // save merges onto the settings shown then.
  workspaceWritesRef.current = { save: saveWorkspaceSettings, reset: resetWorkspaceSettings };

  // Trusted opens main's dialog, and the person answers there. Restricted
  // Mode also stops the workspace's running app commands.
  const { requestTrust, restrict } = workspaceTrust;
  const changeWorkspaceTrust = useCallback(async (value: "trusted" | "restricted") => {
    try {
      if (value === "trusted") await requestTrust();
      else await restrict();
    } catch (cause) {
      props.onError?.(
        ipcErrorMessage(cause, value === "trusted"
          ? "dohc could not trust this workspace."
          : "dohc could not put this workspace in Restricted Mode."),
        cause,
        () => changeWorkspaceTrust(value),
      );
    }
  }, [props.onError, requestTrust, restrict]);

  const checkForUpdates = useCallback(async () => {
    setUpdateBusy("check");
    setUpdateError(null);
    try {
      const result = await bridge().checkForUpdates();
      acceptUpdateResult(result.state);
      if (!result.checked) {
        setUpdateError(
          result.state.status === "error"
            ? result.state.message
            : "No update check was started.",
        );
      } else if (result.state.status === "error") {
        setUpdateError(result.state.message);
      }
    } catch {
      setUpdateError("Could not check for updates.");
    } finally {
      setUpdateBusy(null);
    }
  }, [acceptUpdateResult]);

  const installUpdate = useCallback(async () => {
    setUpdateBusy("install");
    setUpdateError(null);
    try {
      // Through the guard: with set-aside drafts
      // present the recovery dialog opens instead of the one-shot install.
      const result = await requestGuardedUpdateInstall();
      if (result === null) return;
      acceptUpdateResult(result.state);
      // Main says why an install failed when it knows, such as a Linux password prompt that was closed.
      if (!result.accepted) {
        setUpdateError(
          result.reason ?? (result.state.status === "error" ? result.state.message : "Could not restart into the update."),
        );
      } else if (result.state.status === "error") {
        setUpdateError(result.state.message);
      }
    } catch {
      setUpdateError("Could not restart into the update.");
    } finally {
      setUpdateBusy(null);
    }
  }, [acceptUpdateResult]);

  const userSettings = userResult?.settings ?? DEFAULT_USER_SETTINGS;
  const agent = firstAgent(userSettings);
  const workspaceSettings = workspaceResult?.settings ?? DEFAULT_WORKSPACE_SETTINGS;
  const activeMeta =
    SETTINGS_SECTIONS.find((section) => section.id === activeSection) ??
    SETTINGS_SECTIONS[0];
  const zoomModified = isModified(
    userSettings.appearance.zoomLevel,
    DEFAULT_USER_SETTINGS.appearance.zoomLevel,
  );
  const editorSizeModified = isModified(userSettings.editor.fontSize, DEFAULT_USER_SETTINGS.editor.fontSize);
  const shortcutPlatform = window.dohcDesktop?.platform;

  const warnings = [
    userResult?.warning,
    workspaceResult?.warning,
    workspaceResult?.refusal,
    error ? `Settings error: ${error}` : null,
  ].filter((message): message is string => Boolean(message));

  const saveAppearance = (patch: Partial<DesktopUserSettings["appearance"]>) =>
    saveUserSettings({ ...userSettings, appearance: { ...userSettings.appearance, ...patch } });
  const saveEditor = (patch: Partial<DesktopUserSettings["editor"]>) =>
    saveUserSettings({ ...userSettings, editor: { ...userSettings.editor, ...patch } });
  // Setting up an agent stays in this dialog, and clears a search that
  // would hide the Agents section.
  const askAgent = props.askAgent
    ? {
        ...props.askAgent,
        setUp: () => {
          setQuery("");
          setActiveSection("agents");
        },
      }
    : undefined;
  const askAgentAside = (target?: CustomizeTarget) =>
    askAgent ? (
      <AskAgentButton
        askAgent={askAgent}
        request={target ? { kind: "settings", target } : { kind: "settings" }}
      />
    ) : null;
  const customizeRow = (row: string) =>
    props.focus?.row === row ? { highlighted: true, aside: askAgentAside(props.focus) } : {};

  const renderSection = () => {
    if (query.trim() && filteredSections.length === 0) {
      if (sharingResults.length > 0) return null;
      return (
        <div
          data-testid={desktopPins.settingsEmptySearch}
          className="flex h-40 items-center justify-center rounded-lg border border-dashed border-line text-sm text-muted"
        >
          {`No settings match "${query}".`}
        </div>
      );
    }

    if (!props.workspaceIsReady && activeMeta.scope !== "User") {
      if (props.workspaceOpenFailed) {
        return <p className="text-sm text-muted">Couldn’t open this workspace. Close Settings to try again.</p>;
      }
      return <SkeletonRows layout="panel" label="Loading settings..." />;
    }

    switch (activeSection) {
      case "appearance":
        return (
          <div data-testid={settingsSectionPin("appearance")}>
            <SettingsSection title="App">
              <SettingRow
                title="Theme"
                modified={isModified(
                  userSettings.appearance.themeMode,
                  DEFAULT_USER_SETTINGS.appearance.themeMode,
                )}
                onReset={() =>
                  void saveUserSettings({
                    ...userSettings,
                    appearance: {
                      ...userSettings.appearance,
                      themeMode: DEFAULT_USER_SETTINGS.appearance.themeMode,
                    },
                  })
                }
                testId="settings-row-theme"
              >
                <ThemeControl
                  value={userSettings.appearance.themeMode}
                  onChange={(themeMode) =>
                    void saveUserSettings({
                      ...userSettings,
                      appearance: { ...userSettings.appearance, themeMode },
                    })
                  }
                />
              </SettingRow>
              <SettingRow
                title="Zoom"
                modified={zoomModified}
                onReset={() => void stepZoomSetting("reset")}
                testId="settings-row-zoom"
              >
                <StepperControl
                  setting="zoom"
                  value={`${zoomPercent(userSettings.appearance.zoomLevel)}%`}
                  decrease={{
                    label: "Zoom out",
                    keys: shortcutKeys("zoom-out", shortcutPlatform),
                    disabled: userSettings.appearance.zoomLevel <= MIN_ZOOM_LEVEL,
                    onClick: () => void stepZoomSetting("out"),
                  }}
                  reset={{
                    label: `Reset to ${zoomPercent(DEFAULT_USER_SETTINGS.appearance.zoomLevel)}%`,
                    to: `${zoomPercent(DEFAULT_USER_SETTINGS.appearance.zoomLevel)}%`,
                    keys: shortcutKeys("zoom-reset", shortcutPlatform),
                    onClick: () => {
                      if (zoomModified) void stepZoomSetting("reset");
                    },
                  }}
                  increase={{
                    label: "Zoom in",
                    keys: shortcutKeys("zoom-in", shortcutPlatform),
                    disabled: userSettings.appearance.zoomLevel >= MAX_ZOOM_LEVEL,
                    onClick: () => void stepZoomSetting("in"),
                  }}
                />
              </SettingRow>
              <SettingRow
                title="Accent color"
                modified={userSettings.appearance.accentColor !== null}
                onReset={() => void saveAppearance({ accentColor: null })}
                testId="settings-row-accent"
              >
                <ColorControl
                  label="Accent color"
                  value={userSettings.appearance.accentColor ??
                    palette[document.documentElement.dataset.theme === "dark" ? "dark" : "light"].accent}
                  onChange={(accentColor) => void saveAppearance({ accentColor })}
                />
              </SettingRow>
              <SettingRow
                title="Sidebar"
                top
                modified={
                  isModified(userSettings.sidebar.order, DEFAULT_SIDEBAR_SETTINGS.order) ||
                  isModified(userSettings.sidebar.hidden, DEFAULT_SIDEBAR_SETTINGS.hidden)
                }
                onReset={() =>
                  void saveUserSettings({
                    ...userSettings,
                    sidebar: {
                      ...userSettings.sidebar,
                      order: DEFAULT_SIDEBAR_SETTINGS.order,
                      hidden: DEFAULT_SIDEBAR_SETTINGS.hidden,
                    },
                  })
                }
                testId="settings-row-sidebar"
                {...customizeRow("settings-row-sidebar")}
              >
                <SidebarViewsControl
                  sidebar={userSettings.sidebar}
                  onChange={(sidebar) => void saveUserSettings({ ...userSettings, sidebar })}
                />
              </SettingRow>
            </SettingsSection>
            <SettingsSection title="Your colors">
              <SettingRow
                title="Your color"
                modified={userSettings.appearance.yourColor !== null}
                onReset={() => void saveAppearance({ yourColor: null })}
                testId="settings-row-your-color"
                {...customizeRow("settings-row-your-color")}
              >
                <ChatAvatar presentation={ownPresentation} name={userSettings.profile.preferredName ?? "You"} kind="human" size="comment" />
                <HueControl
                  label="Your color"
                  shape="person"
                  value={userSettings.appearance.yourColor}
                  onChange={(yourColor) => void saveAppearance({ yourColor })}
                />
              </SettingRow>
              {agent ? (
                <SettingRow title="Your agent's color" testId="settings-row-your-agent-color">
                  <ChatAvatar presentation={ownAgentPresentation} name={agent.name} kind="agent" size="comment" />
                  <HueControl
                    label="Your agent's color"
                    shape="agent"
                    value={agent.hue}
                    onChange={(hue) => void saveUserSettings(withAgent(userSettings, agent.id, (current) => ({ ...current, hue })))}
                  />
                </SettingRow>
              ) : null}
            </SettingsSection>
            <SettingsSection title="Editor">
              <SettingRow
                title="Editor font"
                modified={isModified(userSettings.editor.fontFamily, DEFAULT_USER_SETTINGS.editor.fontFamily)}
                onReset={() => void saveEditor({ fontFamily: DEFAULT_USER_SETTINGS.editor.fontFamily })}
                testId="settings-row-editor-font"
                {...customizeRow("settings-row-editor-font")}
              >
                <SegmentedControl
                  label="Editor font"
                  value={userSettings.editor.fontFamily}
                  options={[
                    { value: "sans", label: "Sans" },
                    { value: "serif", label: "Serif" },
                    { value: "mono", label: "Mono" },
                    // A font installed on this computer that the file names.
                    ...((EDITOR_FONTS as readonly string[]).includes(userSettings.editor.fontFamily)
                      ? []
                      : [{ value: userSettings.editor.fontFamily, label: userSettings.editor.fontFamily }]),
                  ]}
                  onChange={(fontFamily) => void saveEditor({ fontFamily })}
                />
              </SettingRow>
              <SettingRow
                title="Editor text size"
                modified={editorSizeModified}
                onReset={() => void saveEditor({ fontSize: DEFAULT_USER_SETTINGS.editor.fontSize })}
                testId="settings-row-editor-size"
              >
                <StepperControl
                  setting="editor text size"
                  value={`${userSettings.editor.fontSize}px`}
                  decrease={{
                    label: "Smaller editor text",
                    disabled: userSettings.editor.fontSize <= MIN_EDITOR_FONT_SIZE,
                    onClick: () => void saveEditor({ fontSize: userSettings.editor.fontSize - 1 }),
                  }}
                  reset={{
                    label: `Reset to ${DEFAULT_USER_SETTINGS.editor.fontSize}px`,
                    to: `${DEFAULT_USER_SETTINGS.editor.fontSize}px`,
                    onClick: () => {
                      if (editorSizeModified) void saveEditor({ fontSize: DEFAULT_USER_SETTINGS.editor.fontSize });
                    },
                  }}
                  increase={{
                    label: "Larger editor text",
                    disabled: userSettings.editor.fontSize >= MAX_EDITOR_FONT_SIZE,
                    onClick: () => void saveEditor({ fontSize: userSettings.editor.fontSize + 1 }),
                  }}
                />
              </SettingRow>
            </SettingsSection>
          </div>
        );
      case "keyboard":
        return (
          <div data-testid={settingsSectionPin("keyboard")}>
            <KeyboardSettings platform={shortcutPlatform} devTools={bridge().devTools} query={query} />
          </div>
        );
      case "agents":
        return (
          <div data-testid={settingsSectionPin("agents")}>
            <AgentsMcpSettings
              onError={props.onError}
              workspaceId={props.workspaceId}
              workspacePath={props.workspacePath}
              preferredName={userSettings.profile.preferredName}
              agentName={agent?.name}
              onAgentNameChange={(name) =>
                saveUserSettings(withFirstAgent(userSettings, (current) => ({
                  ...(current ?? newAgentDefaults(userSettings, userSettings.appearance.yourColor ?? ownPresentation.hue)),
                  name,
                })))
              }
              onPreferredNameChange={(preferredName) =>
                saveUserSettings({
                  ...userSettings,
                  profile: { ...userSettings.profile, preferredName },
                })
              }
              agent={agent}
              sharedView={props.sharedView}
              sessionRecorderOn={props.sessionRecorderOn}
              onAgentChange={(fields) =>
                saveUserSettings(withFirstAgent(userSettings, (current) => ({
                  ...(current ?? {
                    ...newAgentDefaults(userSettings, userSettings.appearance.yourColor ?? ownPresentation.hue),
                    name: "Agent",
                  }),
                  ...fields,
                })))
              }
            />
          </div>
        );
      case "cloud":
        return (
          <div data-testid={settingsSectionPin("cloud")}>
            <SettingsSection>
              {props.cloud ? (
                <CloudSyncSettings workspaceId={props.workspaceId} sharedView={props.sharedView} cloud={props.cloud} />
              ) : null}
              {!props.sharedView && props.onOpenLiveDocuments ? (
                <SettingRow
                  title="Live documents"
                  description="Documents this workspace is editing live. Stopping one keeps the file and its history."
                  testId="settings-row-live-documents"
                >
                  <button
                    type="button"
                    aria-label="Open live documents"
                    onClick={props.onOpenLiveDocuments}
                    className="h-8 rounded-lg bg-accent px-3 text-[13px] font-medium text-bg transition-opacity hover:opacity-90"
                  >
                    Open
                  </button>
                </SettingRow>
              ) : null}
            </SettingsSection>
          </div>
        );
      case "workbench":
        return (
          <div data-testid={settingsSectionPin("workbench")}>
            <SettingsSection>
              <SettingRow
                title="App previews"
                modified={isModified(
                  workspaceSettings.sites.defaultPreviewMode,
                  DEFAULT_WORKSPACE_SETTINGS.sites.defaultPreviewMode,
                )}
                onReset={() =>
                  void saveWorkspaceSettings({
                    sites: {
                      defaultPreviewMode:
                        DEFAULT_WORKSPACE_SETTINGS.sites.defaultPreviewMode,
                    },
                  })
                }
                testId="settings-row-site-preview-mode"
              >
                <select
                  aria-label="Default app preview mode"
                  data-testid="site-preview-mode-select"
                  value={workspaceSettings.sites.defaultPreviewMode}
                  onChange={(event) =>
                    void saveWorkspaceSettings({
                      sites: {
                        defaultPreviewMode: event.target
                          .value as WorkspaceSettings["sites"]["defaultPreviewMode"],
                      },
                    })
                  }
                  className="h-8 w-64 rounded-md border border-line bg-bg px-2 text-[12px] text-ink focus:border-ink"
                >
                  {WORKSPACE_PREVIEW_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode.slice(0, 1).toUpperCase() + mode.slice(1)}
                    </option>
                  ))}
                </select>
              </SettingRow>
            </SettingsSection>
          </div>
        );
      case "files":
        return (
          <div data-testid={settingsSectionPin("files")}>
            <SettingsSection>
              <SettingRow
                title="Attachments"
                modified={isModified(
                  workspaceSettings.files.attachmentLocation,
                  DEFAULT_WORKSPACE_SETTINGS.files.attachmentLocation,
                )}
                onReset={() =>
                  void saveWorkspaceSettings({
                    files: {
                      attachmentLocation:
                        DEFAULT_WORKSPACE_SETTINGS.files.attachmentLocation,
                    },
                  })
                }
                testId="settings-row-attachment-location"
              >
                <select
                  aria-label="Attachment location"
                  data-testid="attachment-location-select"
                  value={workspaceSettings.files.attachmentLocation}
                  onChange={(event) =>
                    void saveWorkspaceSettings({
                      files: {
                        attachmentLocation: event.target
                          .value as WorkspaceSettings["files"]["attachmentLocation"],
                      },
                    })
                  }
                  // As wide as its longest option, which names the folder.
                  className="h-8 max-w-full rounded-md border border-line bg-bg px-2 text-[12px] text-ink focus:border-ink"
                >
                  <option value="per-document">
                    {`In a folder next to the document (${
                      workspaceSettings.files.attachmentFolderName || "assets"
                    }/)`}
                  </option>
                  <option value="global-folder">
                    In one folder at the workspace root
                  </option>
                  <option value="same-folder">Next to the document</option>
                </select>
              </SettingRow>
              {workspaceSettings.files.attachmentLocation !== "same-folder" ? (
                <SettingRow
                  title="Attachment folder name"
                  modified={isModified(
                    workspaceSettings.files.attachmentFolderName,
                    DEFAULT_WORKSPACE_SETTINGS.files.attachmentFolderName,
                  )}
                  onReset={() =>
                    void saveWorkspaceSettings({
                      files: {
                        attachmentFolderName:
                          DEFAULT_WORKSPACE_SETTINGS.files.attachmentFolderName,
                      },
                    })
                  }
                  testId="settings-row-attachment-folder"
                >
                  <TextControl
                    label="Attachment folder name"
                    value={workspaceSettings.files.attachmentFolderName}
                    placeholder="assets"
                    testId="attachment-folder-input"
                    maxLength={ATTACHMENT_FOLDER_NAME_MAX_LENGTH}
                    onChange={(attachmentFolderName) =>
                      void saveWorkspaceSettings({
                        files: {
                          // mergeWorkspaceSettings re-parses and throws past the
                          // schema bound, and this is a plain change handler — an
                          // over-long value must be clamped, not thrown. `maxLength`
                          // already stops typing and pasting; this is the belt to
                          // its braces (a longer value can only arrive if the two
                          // ever drift).
                          attachmentFolderName: attachmentFolderName.slice(
                            0,
                            ATTACHMENT_FOLDER_NAME_MAX_LENGTH,
                          ),
                        },
                      })
                    }
                  />
                </SettingRow>
              ) : null}
            </SettingsSection>
          </div>
        );
      case "privacy":
        return (
          <div data-testid={settingsSectionPin("privacy")}>
            <SettingsSection title="This workspace">
              {!props.sharedView ? (
                <SettingRow
                  title="Workspace trust"
                  description="A trusted workspace runs its apps' dev and build commands, and starts agents, on this computer."
                  testId="settings-row-workspace-trust"
                >
                  <div className="shrink-0 whitespace-nowrap">
                    <SegmentedControl
                      label="Workspace trust"
                      testId="workspace-trust-control"
                      value={workspaceTrust.trusted ? "trusted" : "restricted"}
                      options={[
                        { value: "trusted", label: "Trusted" },
                        { value: "restricted", label: "Restricted Mode" },
                      ]}
                      disabled={workspaceTrust.trusted === null || workspaceTrust.asking}
                      onChange={(value) => void changeWorkspaceTrust(value)}
                    />
                  </div>
                </SettingRow>
              ) : null}
              <SettingRow
                title="Confirm external links"
                description="Ask before dohc opens a link in another app."
                modified={isModified(
                  workspaceSettings.privacy.confirmExternalLinks,
                  DEFAULT_WORKSPACE_SETTINGS.privacy.confirmExternalLinks,
                )}
                onReset={() =>
                  void saveWorkspaceSettings({
                    privacy: {
                      confirmExternalLinks:
                        DEFAULT_WORKSPACE_SETTINGS.privacy.confirmExternalLinks,
                    },
                  })
                }
              >
                <SwitchControl
                  label="Confirm external links"
                  checked={workspaceSettings.privacy.confirmExternalLinks}
                  onChange={(confirmExternalLinks) =>
                    void saveWorkspaceSettings({ privacy: { confirmExternalLinks } })
                  }
                />
              </SettingRow>
            </SettingsSection>
            <SettingsSection title="Reports">
              <ReportsSettings
                privacy={userSettings.privacy}
                onChange={(privacy) => void saveUserSettings({ ...userSettings, privacy })}
                onError={props.onError}
              />
            </SettingsSection>
            <UsageRecordSettings onError={props.onError} />
          </div>
        );
      case "advanced":
        return (
          <div data-testid={settingsSectionPin("advanced")}>
            <SettingsSection>
              <ScheduleHostRow
                workspaceId={props.workspaceId}
                {...(props.onError ? { onError: props.onError } : {})}
              />
              <SettingRow
                title="Settings file"
                description="Changes apply when you save the file."
                testId="settings-row-settings-file"
                aside={askAgentAside()}
              >
                {settingsFilePath ? (
                  <code
                    title={settingsFilePath}
                    className="max-w-70 select-text cursor-text truncate rounded-md bg-panel-2 px-2 py-1 font-mono text-[11px] text-ink"
                  >
                    {settingsFilePath}
                  </code>
                ) : null}
                <button
                  type="button"
                  aria-label="Open settings file"
                  onClick={() => void openSettingsFile()}
                  className="h-8 shrink-0 rounded-lg border border-line bg-transparent px-3 text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink"
                >
                  Open
                </button>
              </SettingRow>
              <SettingRow
                title="Reset user settings"
                description="Restore local user settings for this desktop install to defaults."
                modified={isModified(userSettings, DEFAULT_USER_SETTINGS)}
                testId="settings-row-reset-user"
              >
                <button
                  type="button"
                  onClick={() => void resetUserSettings()}
                  className="h-8 rounded-lg border border-line bg-transparent px-3 text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink"
                >
                  Reset user
                </button>
              </SettingRow>
              <SettingRow
                title="Reset workspace settings"
                description="Restore local settings for this workspace without touching workspace content."
                modified={isModified(workspaceSettings, DEFAULT_WORKSPACE_SETTINGS)}
                testId="settings-row-reset-workspace"
              >
                <button
                  type="button"
                  onClick={() => void resetWorkspaceSettings()}
                  className="h-8 rounded-lg border border-line bg-transparent px-3 text-[13px] text-muted transition-colors hover:bg-hover hover:text-ink"
                >
                  Reset workspace
                </button>
              </SettingRow>
            </SettingsSection>
          </div>
        );
      case "general":
      default:
        return (
          <div data-testid={settingsSectionPin("general")}>
            <SettingsSection title="Profile">
              <SettingRow
                title="Your name"
                modified={isModified(
                  userSettings.profile.preferredName,
                  DEFAULT_USER_SETTINGS.profile.preferredName,
                )}
                onReset={() =>
                  void saveUserSettings({
                    ...userSettings,
                    profile: { ...userSettings.profile, preferredName: undefined },
                  })
                }
                testId="settings-row-preferred-name"
              >
                <PreferredNameControl
                  value={userSettings.profile.preferredName}
                  onChange={(preferredName) =>
                    saveUserSettings({
                      ...userSettings,
                      profile: { ...userSettings.profile, preferredName },
                    })
                  }
                  testIdPrefix="general-preferred-name"
                />
              </SettingRow>
            </SettingsSection>
            <SettingsSection title="App">
              <SettingRow
                title="Updates"
                description={
                  <span data-testid="desktop-updates-status" data-state={updateState?.status ?? "unknown"}>
                    {updateError ?? updateState?.message ?? "Update status unavailable."}
                  </span>
                }
                aside={updateState?.installCommand ? (
                  <CopyField label="Copy install command" copiedLabel="Install command copied"
                    copyTestId="desktop-updates-install-command-copy" getText={() => updateState.installCommand ?? null}>
                    <code data-testid="desktop-updates-install-command" title={updateState.installCommand}>
                      {updateState.installCommand}
                    </code>
                  </CopyField>
                ) : undefined}
                testId="settings-row-desktop-updates"
              >
                <span className="mr-1 shrink-0 text-[12px] tabular-nums text-subtle">
                  <span data-testid="desktop-updates-version">{updateState?.currentVersion ?? "unknown"}</span>
                  {" · "}
                  <span data-testid="desktop-updates-channel">{updateState?.channel ?? "unknown"}</span>
                </span>
                <button
                  type="button"
                  data-testid="check-updates-button"
                  disabled={updateBusy !== null || updateState?.canCheck === false}
                  onClick={() => void checkForUpdates()}
                  className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-line px-3 text-[13px] text-muted transition-colors enabled:hover:bg-hover enabled:hover:text-ink disabled:opacity-50"
                >
                  <RefreshCw size={12} aria-hidden />
                  {updateBusy === "check" ? "Checking" : "Check"}
                </button>
                {/* Quiet until an update is ready: only then is Restart the next step. */}
                <button
                  type="button"
                  data-testid="install-update-button"
                  disabled={updateBusy !== null || updateState?.canInstall !== true}
                  onClick={() => void installUpdate()}
                  className={`h-8 shrink-0 rounded-lg px-3 text-[13px] transition-opacity disabled:opacity-50 ${
                    updateState?.canInstall === true
                      ? "bg-accent font-medium text-bg enabled:hover:opacity-90"
                      : "border border-line text-subtle"
                  }`}
                >
                  {updateBusy === "install" ? "Restarting" : "Restart"}
                </button>
              </SettingRow>
            </SettingsSection>
          </div>
        );
    }
  };

  const visibleSections = query.trim() ? filteredSections : SETTINGS_SECTIONS;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      tabIndex={-1}
      data-testid={desktopPins.settingsDialog}
      data-active-section={activeSection}
      className="dohc-elevated relative flex h-[min(760px,calc(100vh-112px))] w-[min(1040px,calc(100vw-32px))] overflow-hidden rounded-xl border border-line bg-bg max-[720px]:flex-col"
    >
      <SettingsNav
        workspacePath={props.workspacePath}
        sections={visibleSections}
        activeSection={activeSection}
        onSelect={setActiveSection}
        query={query}
        onQuery={setQuery}
        status={<StatusPill state={saveState} />}
      />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {warnings.length > 0 ? (
          <div className="flex shrink-0 flex-col gap-1 border-b border-line bg-panel px-12 py-2 max-[720px]:px-4">
            {warnings.map((warning, index) => (
              <div
                key={`${index}-${warning}`}
                data-testid={desktopPins.settingsWarning}
                className="flex items-center gap-2 text-[11px] text-warning"
              >
                <AlertTriangle size={12} aria-hidden />
                {warning}
              </div>
            ))}
          </div>
        ) : null}

        {/* The right padding keeps the title clear of the close button. */}
        <section className="min-h-0 flex-1 overflow-auto px-12 pb-12 pt-10 max-[720px]:px-4 max-[720px]:py-4">
          {/* Only Sharing matched: no section's heading stands over its results. */}
          <h3
            hidden={!!query.trim() && filteredSections.length === 0 && sharingResults.length > 0}
            className="m-0 mb-6 text-base font-semibold text-ink"
          >
            {activeMeta.label}
          </h3>
          {props.onOpenSharing ? <SharingSearchResults results={sharingResults} onOpen={props.onOpenSharing} /> : null}
          {renderSection()}
        </section>
      </main>

      <button
        ref={closeRef}
        type="button"
        aria-label="Close settings"
        title="Close settings"
        onClick={props.onClose}
        className="absolute right-3 top-3 grid size-7 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink"
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
