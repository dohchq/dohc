import { useRequestSequence } from "../useRequestSequence";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Minus,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { WORKSPACE_PREVIEW_MODES } from "@dohc/workspace-contracts/workspace-settings-values";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_USER_SETTINGS,
  type DesktopUserSettingsResult,
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  type DesktopUserSettings,
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
import { requestGuardedUpdateInstall } from "../RecoveryCloseGuard";
import { applyAppearanceSettings } from "../theme";
import { useDesktopUpdateStateFeed } from "../useDesktopUpdateStateFeed";
import { AgentsMcpSettings } from "./AgentsMcpSettings";
import { PreferredNameControl } from "./PreferredNameControl";
import { SegmentedControl, SettingRow, SwitchControl, TextControl } from "./SettingRow";
import { SharedByMeList } from "./SharedByMeList";
import { SharedWithMeList } from "./SharedWithMeList";
import {
  DEFAULT_SETTINGS_SECTION,
  isSettingsSectionId,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "./settingsRegistry";

type SaveState = "idle" | "saving" | "saved" | "error";

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

function StatusPill(props: { state: SaveState }) {
  if (props.state === "idle") return null;
  return (
    <span
      data-testid="settings-save-state"
      data-state={props.state}
      className={`ml-auto flex items-center gap-1 text-[11px] ${
        props.state === "error" ? "text-danger" : "text-subtle"
      }`}
    >
      {props.state === "saved" ? <CheckCircle2 size={12} aria-hidden /> : null}
      {props.state === "saving" ? "Saving..." : props.state === "saved" ? "Saved" : "Save failed"}
    </span>
  );
}

export function SettingsDialog(props: {
  onError?: (message: string) => void;
  workspaceId: string;
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
  onClose: () => void;
  onAgentActiveChange?: (update: {
    active: boolean;
    /**
     * True only when this panel started or ended the run itself. An
     * observation may be older than a refresh the shell already has in
     * flight, so it must never supersede one.
     */
    mutated: boolean;
  }) => void;
  onOpenCloud?: () => void;
  /**
   * Opens this workspace's live documents. Owned workspaces only: a shared
   * view runs no owner live delivery, so it has no such list to manage.
   */
  onOpenLiveDocuments?: () => void;
  onWorkspaceFilesChanged?: (outcome?: {
    // The removal cleaned up the record but left its folder on disk. The
    // shell needs the id before its reload sees the record vanish.
    folderLeftShareId?: string;
  }) => void;
}) {
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
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = useState<"check" | "install" | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const { updateState, acceptUpdateResult } =
    useDesktopUpdateStateFeed(() => setUpdateError(null));
  const saveStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    closeRef.current?.focus();
  }, []);

  useEffect(() => () => clearSaveStateTimer(), [clearSaveStateTimer]);

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
      bridge().getWorkspaceSettings({ workspaceId: props.workspaceId }),
    ])
      .then(([nextUser, nextWorkspace]) => {
        if (cancelled) return;
        if (!settingsEventFiredRef.current) setUserResult(nextUser);
        applyAppearanceSettings(nextUser.settings.appearance);
        if (!workspaceTokenRef.isCurrent(token)) return;
        setWorkspaceResult(nextWorkspace);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.workspaceId]);

  const filteredSections = useMemo(
    () => SETTINGS_SECTIONS.filter((section) => sectionMatches(section, query)),
    [query],
  );

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
    applyAppearanceSettings(settings.appearance);
    markSaving();
    setError(null);
    try {
      const saved = await bridge().setUserSettings({ settings });
      if (!userSaveRequestRef.isCurrent(requestId)) return;
      setUserResult(saved);
      markSaved();
    } catch (cause) {
      if (!userSaveRequestRef.isCurrent(requestId)) return;
      setUserResult(previous);
      applyAppearanceSettings(previous.settings.appearance);
      setSaveState("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [markSaved, markSaving, userResult]);

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
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [markSaved, markSaving, props.workspaceId, workspaceResult],
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
      // The refusal carries the reason; this surface owns the next step —
      // "open Settings" would name the dialog the user is already in.
      setError(
        `${
          cause instanceof Error ? cause.message : String(cause)
        } Use Reset user settings in the Advanced section, or repair the file.`,
      );
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
      applyAppearanceSettings(next.settings.appearance);
      markSaved();
    } catch (cause) {
      if (!userSaveRequestRef.isCurrent(requestId)) return;
      setSaveState("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [markSaved, markSaving]);

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
      markSaved();
    } catch (cause) {
      if (
        !workspaceTokenRef.isCurrent(token) ||
        !workspaceSaveRequestRef.isCurrent(requestId)
      ) {
        return;
      }
      setSaveState("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [markSaved, markSaving, props.workspaceId]);

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
      if (!result.accepted) {
        setUpdateError(
          result.state.status === "error"
            ? result.state.message
            : "Could not restart into the update.",
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
  const workspaceSettings = workspaceResult?.settings ?? DEFAULT_WORKSPACE_SETTINGS;
  const activeMeta =
    SETTINGS_SECTIONS.find((section) => section.id === activeSection) ??
    SETTINGS_SECTIONS[0];

  const warnings = [
    userResult?.warning,
    workspaceResult?.warning,
    workspaceResult?.refusal,
    error ? `Settings error: ${error}` : null,
  ].filter((message): message is string => Boolean(message));

  const renderSection = () => {
    if (query.trim() && filteredSections.length === 0) {
      return (
        <div
          data-testid="settings-empty-search"
          className="flex h-40 items-center justify-center rounded-lg border border-dashed border-line text-sm text-muted"
        >
          {`No settings match "${query}".`}
        </div>
      );
    }

    switch (activeSection) {
      case "appearance":
        return (
          <div data-testid="settings-section-appearance">
            <SettingRow
              title="Theme"
              description="Choose whether dohc follows the system theme or uses an explicit light or dark mode."
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
              <SegmentedControl
                label="Theme"
                value={userSettings.appearance.themeMode}
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
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
              description="Scales the whole window. Ctrl/Cmd+= zooms in, Ctrl/Cmd+- zooms out, Ctrl/Cmd+0 resets."
              modified={isModified(
                userSettings.appearance.zoomLevel,
                DEFAULT_USER_SETTINGS.appearance.zoomLevel,
              )}
              onReset={() => void stepZoomSetting("reset")}
              testId="settings-row-zoom"
            >
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label="Zoom out"
                  disabled={userSettings.appearance.zoomLevel <= MIN_ZOOM_LEVEL}
                  onClick={() => void stepZoomSetting("out")}
                  className="grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-subtle"
                >
                  <Minus size={14} strokeWidth={1.9} />
                </button>
                <span className="min-w-12 text-center font-mono text-[12px] text-ink">
                  {zoomPercent(userSettings.appearance.zoomLevel)}%
                </span>
                <button
                  type="button"
                  aria-label="Zoom in"
                  disabled={userSettings.appearance.zoomLevel >= MAX_ZOOM_LEVEL}
                  onClick={() => void stepZoomSetting("in")}
                  className="grid size-6 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-subtle"
                >
                  <Plus size={14} strokeWidth={1.9} />
                </button>
              </div>
            </SettingRow>
          </div>
        );
      case "agents":
        return (
          <div data-testid="settings-section-agents">
            <AgentsMcpSettings
              onError={props.onError}
              workspaceId={props.workspaceId}
              workspacePath={props.workspacePath}
              preferredName={userSettings.profile.preferredName}
              agentName={userSettings.profile.agentName}
              onAgentNameChange={(agentName) => saveUserSettings({ ...userSettings, profile: { ...userSettings.profile, agentName } })}
              onPreferredNameChange={(preferredName) =>
                saveUserSettings({
                  ...userSettings,
                  profile: { ...userSettings.profile, preferredName },
                })
              }
              runner={userSettings.runner}
              sharedView={props.sharedView}
              sessionRecorderOn={props.sessionRecorderOn}
              onRunnerChange={(runner) =>
                saveUserSettings({
                  ...userSettings,
                  runner,
                })
              }
              onAgentActiveChange={props.onAgentActiveChange}
            />
          </div>
        );
      case "cloud":
        return (
          <div data-testid="settings-section-cloud">
            <SettingRow
              title="Sync and sharing"
              description="Connect a server, sync this workspace, and manage who you share it with."
            >
              <button
                type="button"
                aria-label="Open sync and sharing"
                onClick={props.onOpenCloud}
                className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
                disabled={!props.onOpenCloud}
              >
                Open
              </button>
            </SettingRow>
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
                  className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-bg transition-opacity hover:opacity-90"
                >
                  Open
                </button>
              </SettingRow>
            ) : null}
            <SettingRow
              title="Shared by me"
              description="Read-only views you've shared with other dohc accounts. Ending a share stops their access on their next refresh."
            >
              <span aria-hidden />
            </SettingRow>
            <div className="px-1 pb-2">
              <SharedByMeList workspaceId={props.workspaceId} />
            </div>
            <SettingRow
              title="Shared with me"
              description="Files other dohc accounts shared to you. Adding one places it in this workspace under shared-with-me/ — read-only, kept up to date, readable by your agent."
            >
              <span aria-hidden />
            </SettingRow>
            <div className="px-1 pb-2">
              <SharedWithMeList
                workspaceId={props.workspaceId}
                {...(props.onWorkspaceFilesChanged
                  ? { onWorkspaceFilesChanged: props.onWorkspaceFilesChanged }
                  : {})}
              />
            </div>
          </div>
        );
      case "workbench":
        return (
          <div data-testid="settings-section-workbench">
            <SettingRow
              title="App previews"
              description="Choose the mode Apps tries first when an app has no preview mode of its own."
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
            <SettingRow
              title="History rail"
              description="Workbench layout restoration remains in workspace UI state. Full defaults arrive in the next workbench slice."
            >
              <span className="text-[11px] text-subtle">Stored in .dohc/ui-state.json</span>
            </SettingRow>
          </div>
        );
      case "files":
        return (
          <div data-testid="settings-section-files">
            <SettingRow
              title="Attachments"
              description="Where pasted images and files are saved."
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
                className="h-8 w-64 rounded-md border border-line bg-bg px-2 text-[12px] text-ink focus:border-ink"
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
                description="Name of the folder attachments are saved into. A single folder name, no slashes."
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
          </div>
        );
      case "privacy":
        return (
          <div data-testid="settings-section-privacy">
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
          </div>
        );
      case "keyboard":
        return (
          <div data-testid="settings-section-keyboard">
            <SettingRow
              title="Open settings"
              description="Open Settings from the command palette, app menu, Activity Bar, or keyboard shortcut."
            >
              <kbd className="rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-[11px] text-subtle">
                Ctrl/Cmd + ,
              </kbd>
            </SettingRow>
          </div>
        );
      case "advanced":
        return (
          <div data-testid="settings-section-advanced">
            <SettingRow
              title="Reset user settings"
              description="Restore local user settings for this desktop install to defaults."
              modified={isModified(userSettings, DEFAULT_USER_SETTINGS)}
              testId="settings-row-reset-user"
            >
              <button
                type="button"
                onClick={() => void resetUserSettings()}
                className="rounded-md border border-line bg-transparent px-3 py-1.5 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
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
                className="rounded-md border border-line bg-transparent px-3 py-1.5 text-[11px] text-muted transition-colors hover:bg-panel-2 hover:text-ink"
              >
                Reset workspace
              </button>
            </SettingRow>
          </div>
        );
      case "general":
      default:
        return (
          <div data-testid="settings-section-general">
            <SettingRow
              title="Your name"
              description="dohc uses this name for human messages and attributes local-agent work to you. It is display-only; permissions use your verified identity."
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
            <SettingRow
              title="Current workspace"
              description="Settings in the Workspace scope apply only to this registered local folder."
              testId="settings-row-current-workspace"
            >
              <code className="max-w-sm select-text cursor-text truncate rounded-md bg-panel-2 px-2 py-1 font-mono text-[11px] text-ink">
                {props.workspacePath}
              </code>
            </SettingRow>
            <SettingRow
              title="Desktop updates"
              description="Check for a new desktop build and restart when an update is ready."
              testId="settings-row-desktop-updates"
            >
              <div className="flex min-w-[260px] flex-col gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Download size={14} aria-hidden className="shrink-0 text-subtle" />
                  <div className="min-w-0 flex-1">
                    <span
                      data-testid="desktop-updates-status"
                      data-state={updateState?.status ?? "unknown"}
                      className="block truncate text-[11px] text-subtle"
                    >
                      {updateError ?? updateState?.message ?? "Update status unavailable."}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="check-updates-button"
                    disabled={updateBusy !== null || updateState?.canCheck === false}
                    onClick={() => void checkForUpdates()}
                    className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-line px-2 text-[11px] text-muted transition-colors hover:bg-line/50 hover:text-ink disabled:opacity-50"
                  >
                    <RefreshCw size={12} aria-hidden />
                    {updateBusy === "check" ? "Checking" : "Check"}
                  </button>
                  <button
                    type="button"
                    data-testid="install-update-button"
                    disabled={updateBusy !== null || updateState?.canInstall !== true}
                    onClick={() => void installUpdate()}
                    className="h-7 shrink-0 rounded-md bg-accent px-2 text-[11px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    {updateBusy === "install" ? "Restarting" : "Restart"}
                  </button>
                </div>
                <dl className="m-0 grid grid-cols-2 gap-2 text-[11px] text-muted">
                  <div>
                    <dt className="text-subtle">Version</dt>
                    <dd data-testid="desktop-updates-version" className="m-0 font-mono text-ink">
                      {updateState?.currentVersion ?? "unknown"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-subtle">Channel</dt>
                    <dd data-testid="desktop-updates-channel" className="m-0 font-mono text-ink">
                      {updateState?.channel ?? "unknown"}
                    </dd>
                  </div>
                </dl>
              </div>
            </SettingRow>
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
      data-testid="settings-dialog"
      data-active-section={activeSection}
      className="dohc-elevated flex h-[min(760px,calc(100vh-48px))] w-[min(1040px,calc(100vw-32px))] overflow-hidden rounded-xl border border-line bg-bg"
    >
      <aside
        data-testid="settings-sidebar"
        className="flex w-56 shrink-0 flex-col border-r border-line bg-panel max-[720px]:hidden"
      >
        <div className="border-b border-line p-4">
          <h2 id="settings-title" className="m-0 text-sm font-semibold text-ink">
            Settings
          </h2>
          <p className="m-0 mt-1 text-[11px] text-subtle">User and workspace controls</p>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-2">
          {visibleSections.map((section) => (
            <button
              key={section.id}
              type="button"
              data-testid={`settings-nav-${section.id}`}
              aria-current={activeSection === section.id ? "page" : undefined}
              onClick={() => setActiveSection(section.id)}
              className={`flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] transition-colors duration-75 ${
                activeSection === section.id
                  ? "bg-line text-ink"
                  : "text-muted hover:bg-panel-2 hover:text-ink"
              }`}
            >
              <section.Icon size={15} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{section.label}</span>
              <span className="font-mono text-[10px] text-subtle">{section.scope}</span>
            </button>
          ))}
        </nav>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-line p-4">
          <div className="relative min-w-0 flex-1">
            <Search
              size={14}
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle"
            />
            <input
              spellCheck={false}
              data-testid="settings-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search settings"
              className="h-8 w-full rounded-md border border-line bg-bg pl-8 pr-3 text-[13px] text-ink placeholder:text-subtle focus:border-ink"
            />
          </div>
          <StatusPill state={saveState} />
          <button
            ref={closeRef}
            type="button"
            aria-label="Close settings"
            onClick={props.onClose}
            className="grid size-8 place-items-center rounded-md text-subtle transition-colors hover:bg-line/50 hover:text-ink"
          >
            <X size={16} aria-hidden />
          </button>
        </header>

        <div className="border-b border-line px-4 py-2 min-[721px]:hidden">
          <select
            aria-label="Settings section"
            value={activeSection}
            onChange={(event) => {
              if (isSettingsSectionId(event.target.value)) {
                setActiveSection(event.target.value);
              }
            }}
            className="h-8 w-full rounded-md border border-line bg-bg px-2 text-[13px] text-ink"
          >
            {visibleSections.map((section) => (
              <option key={section.id} value={section.id}>
                {section.label}
              </option>
            ))}
          </select>
        </div>

        {warnings.length > 0 ? (
          <div className="flex shrink-0 flex-col gap-1 border-b border-line bg-panel px-4 py-2">
            {warnings.map((warning, index) => (
              <div
                key={`${index}-${warning}`}
                data-testid="settings-warning"
                className="flex items-center gap-2 text-[11px] text-warning"
              >
                <AlertTriangle size={12} aria-hidden />
                {warning}
              </div>
            ))}
          </div>
        ) : null}

        <section className="min-h-0 flex-1 overflow-auto px-6 py-5 max-[720px]:px-4">
          <div className="mb-5 flex items-center gap-2.5">
            <h3 className="m-0 text-sm font-semibold text-ink">
              {activeMeta.label}
            </h3>
            <span className="rounded-full border border-line bg-panel-2 px-2 py-0.5 font-mono text-[10px] text-subtle">
              {activeMeta.scope}
            </span>
          </div>
          {renderSection()}
        </section>
      </main>
    </div>
  );
}
