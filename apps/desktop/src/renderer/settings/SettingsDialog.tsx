import {
  AlertTriangle,
  CheckCircle2,
  Download,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { UpdateStateEvent } from "../../ipc/bridgeContract";
import {
  DEFAULT_USER_SETTINGS,
  type DesktopUserSettings,
  type DesktopUserSettingsResult,
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
import { applyAppearanceSettings } from "../theme";
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
  workspaceId: string;
  workspacePath: string;
  /**
   * True when this workspace is a shared view (#589). See the Advanced
   * section: the engine toggle asserts a choice and a recording that a
   * shared view never has.
   */
  sharedView?: boolean;
  initialSection?: SettingsSectionId;
  onClose: () => void;
  onAgentActiveChange?: (update: {
    active: boolean;
    /**
     * True only when this panel started or ended the run itself. An
     * OBSERVATION may be older than a refresh the shell already has in
     * flight, so it must never supersede one.
     */
    mutated: boolean;
  }) => void;
  onOpenCloud?: () => void;
  onWorkspaceFilesChanged?: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const userSaveRequestRef = useRef(0);
  const workspaceSaveRequestRef = useRef(0);
  // Workspace identity token. The request-id refs above only order responses
  // WITHIN one workspace; they say nothing about which workspace a response
  // belongs to. This is bumped whenever props.workspaceId changes, and every
  // workspace-scoped response (load, save, reset) is dropped unless the token it
  // captured still matches — so a slow response for workspace A can never repaint
  // (or, via the next full-settings save, overwrite) workspace B. Mirrors the
  // token guard DesktopWorkspaceShell uses for engine history.
  const workspaceTokenRef = useRef(0);
  const updateSubscriptionFiredRef = useRef(false);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(
    props.initialSection ?? DEFAULT_SETTINGS_SECTION,
  );
  const [query, setQuery] = useState("");
  const [userResult, setUserResult] = useState<DesktopUserSettingsResult | null>(null);
  const [workspaceResult, setWorkspaceResult] =
    useState<WorkspaceSettingsResult | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateStateEvent | null>(null);
  const [updateBusy, setUpdateBusy] = useState<"check" | "install" | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
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

  useEffect(() => {
    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [props.onClose]);

  useEffect(() => () => clearSaveStateTimer(), [clearSaveStateTimer]);

  useEffect(() => {
    let cancelled = false;
    updateSubscriptionFiredRef.current = false;
    void bridge()
      .getUpdateState()
      .then((next) => {
        if (!cancelled && !updateSubscriptionFiredRef.current) {
          setUpdateError(null);
          setUpdateState(next);
        }
      })
      .catch(() => undefined);
    const unsubscribe = bridge().onUpdateState((next) => {
      updateSubscriptionFiredRef.current = true;
      setUpdateError(null);
      setUpdateState(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (props.initialSection) setActiveSection(props.initialSection);
  }, [props.initialSection]);

  useEffect(() => {
    let cancelled = false;
    // New workspace → new token, and DROP the previous workspace's settings.
    // Holding on to them would let a control edited before the new workspace's
    // settings arrive merge workspace A's values into a save aimed at B; with no
    // result, saveWorkspaceSettings refuses ("still loading") instead.
    const token = workspaceTokenRef.current + 1;
    workspaceTokenRef.current = token;
    setWorkspaceResult(null);
    void Promise.all([
      bridge().getUserSettings(),
      bridge().getWorkspaceSettings({ workspaceId: props.workspaceId }),
    ])
      .then(([nextUser, nextWorkspace]) => {
        if (cancelled) return;
        setUserResult(nextUser);
        applyAppearanceSettings(nextUser.settings.appearance);
        if (workspaceTokenRef.current !== token) return;
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
    const requestId = userSaveRequestRef.current + 1;
    userSaveRequestRef.current = requestId;
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
      if (userSaveRequestRef.current !== requestId) return;
      setUserResult(saved);
      markSaved();
    } catch (cause) {
      if (userSaveRequestRef.current !== requestId) return;
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
      const requestId = workspaceSaveRequestRef.current + 1;
      workspaceSaveRequestRef.current = requestId;
      // Capture the workspace this save belongs to. Everything after the await
      // is only allowed to touch state if we are STILL on that workspace.
      const token = workspaceTokenRef.current;
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
          workspaceTokenRef.current !== token ||
          workspaceSaveRequestRef.current !== requestId
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
          workspaceTokenRef.current !== token ||
          workspaceSaveRequestRef.current !== requestId
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

  const resetUserSettings = useCallback(async () => {
    const requestId = userSaveRequestRef.current + 1;
    userSaveRequestRef.current = requestId;
    markSaving();
    setError(null);
    try {
      const next = await bridge().resetUserSettings();
      if (userSaveRequestRef.current !== requestId) return;
      setUserResult(next);
      applyAppearanceSettings(next.settings.appearance);
      markSaved();
    } catch (cause) {
      if (userSaveRequestRef.current !== requestId) return;
      setSaveState("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [markSaved, markSaving]);

  const resetWorkspaceSettings = useCallback(async () => {
    const requestId = workspaceSaveRequestRef.current + 1;
    workspaceSaveRequestRef.current = requestId;
    const token = workspaceTokenRef.current;
    markSaving();
    setError(null);
    try {
      const next = await bridge().resetWorkspaceSettings({
        workspaceId: props.workspaceId,
      });
      if (
        workspaceTokenRef.current !== token ||
        workspaceSaveRequestRef.current !== requestId
      ) {
        return;
      }
      setWorkspaceResult(next);
      markSaved();
    } catch (cause) {
      if (
        workspaceTokenRef.current !== token ||
        workspaceSaveRequestRef.current !== requestId
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
      setUpdateState(result.state);
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
  }, []);

  const installUpdate = useCallback(async () => {
    setUpdateBusy("install");
    setUpdateError(null);
    try {
      const result = await bridge().installUpdate();
      setUpdateState(result.state);
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
  }, []);

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
              title="Density"
              description="Compact density tightens repeated desktop chrome without changing document content."
              modified={isModified(
                userSettings.appearance.density,
                DEFAULT_USER_SETTINGS.appearance.density,
              )}
              onReset={() =>
                void saveUserSettings({
                  ...userSettings,
                  appearance: {
                    ...userSettings.appearance,
                    density: DEFAULT_USER_SETTINGS.appearance.density,
                  },
                })
              }
              testId="settings-row-density"
            >
              <SegmentedControl
                label="Density"
                value={userSettings.appearance.density}
                options={[
                  { value: "comfortable", label: "Comfort" },
                  { value: "compact", label: "Compact" },
                ]}
                onChange={(density) =>
                  void saveUserSettings({
                    ...userSettings,
                    appearance: { ...userSettings.appearance, density },
                  })
                }
              />
            </SettingRow>
            <SettingRow
              title="Reduce motion"
              description="Minimize non-essential motion throughout the desktop app."
              modified={isModified(
                userSettings.appearance.reduceMotion,
                DEFAULT_USER_SETTINGS.appearance.reduceMotion,
              )}
              onReset={() =>
                void saveUserSettings({
                  ...userSettings,
                  appearance: {
                    ...userSettings.appearance,
                    reduceMotion: DEFAULT_USER_SETTINGS.appearance.reduceMotion,
                  },
                })
              }
              testId="settings-row-reduce-motion"
            >
              <SwitchControl
                label="Reduce motion"
                checked={userSettings.appearance.reduceMotion}
                onChange={(reduceMotion) =>
                  void saveUserSettings({
                    ...userSettings,
                    appearance: { ...userSettings.appearance, reduceMotion },
                  })
                }
              />
            </SettingRow>
          </div>
        );
      case "agents":
        return (
          <div data-testid="settings-section-agents">
            <AgentsMcpSettings
              workspaceId={props.workspaceId}
              workspacePath={props.workspacePath}
              preferredName={userSettings.profile.preferredName}
              onPreferredNameChange={(preferredName) =>
                saveUserSettings({
                  ...userSettings,
                  profile: preferredName ? { preferredName } : {},
                })
              }
              runner={userSettings.runner}
              engineEnabled={workspaceSettings.experimental.workspaceEngineAlpha}
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
              title="dohc Cloud"
              description="Connect, sync, and manage cloud collaboration for this workspace."
            >
              <button
                type="button"
                onClick={props.onOpenCloud}
                className="rounded-md bg-accent px-3 py-1.5 text-[11px] font-medium text-bg transition-opacity hover:opacity-90 disabled:opacity-50"
                disabled={!props.onOpenCloud}
              >
                Open Cloud
              </button>
            </SettingRow>
            <SettingRow
              title="Shared by me"
              description="Read-only views you've shared with other dohc accounts. Ending a share stops their access on their next refresh."
            >
              <span aria-hidden />
            </SettingRow>
            <div className="px-1 pb-2">
              <SharedByMeList />
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
              description="Require confirmation before future settings-driven external-link shortcuts open outside dohc."
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
              description="The command palette, app menu, Activity Bar, Status Bar, and accelerator all route here."
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
            {props.sharedView ? (
              // #589: a shared view materializes no settings file, so this
              // read returns the schema default — ON — for a workspace whose
              // open deliberately installed no capture. Rendering the toggle
              // there asserts both a choice nobody made and a recording that
              // never happens. State the capability instead.
              <SettingRow
                title="Workspace engine"
                description="This workspace is a shared view. Its files come from the share, so dohc records nothing here."
                testId="settings-row-workspace-engine-alpha"
              >
                <span
                  data-testid="settings-workspace-engine-share-view"
                  className="text-[11px] text-muted"
                >
                  Shared view — no recording
                </span>
              </SettingRow>
            ) : (
              <SettingRow
                title="Use the workspace engine (default on)"
                description="The workspace engine records this workspace's history, versions, and chats. Turning it off is an escape hatch: no history is recorded while it is off. Takes effect the next time the workspace is opened."
                modified={isModified(
                  workspaceSettings.experimental.workspaceEngineAlpha,
                  DEFAULT_WORKSPACE_SETTINGS.experimental.workspaceEngineAlpha,
                )}
                onReset={() =>
                  void saveWorkspaceSettings({
                    experimental: {
                      workspaceEngineAlpha:
                        DEFAULT_WORKSPACE_SETTINGS.experimental.workspaceEngineAlpha,
                    },
                  })
                }
                testId="settings-row-workspace-engine-alpha"
              >
                <SwitchControl
                  label="Use the workspace engine (default on)"
                  checked={workspaceSettings.experimental.workspaceEngineAlpha}
                  onChange={(workspaceEngineAlpha) =>
                    void saveWorkspaceSettings({ experimental: { workspaceEngineAlpha } })
                  }
                />
              </SettingRow>
            )}
            <SettingRow
              title="Reset user settings"
              description="Restore local user settings for this desktop install to defaults."
              modified={isModified(userSettings, DEFAULT_USER_SETTINGS)}
              onReset={() => void resetUserSettings()}
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
              onReset={() => void resetWorkspaceSettings()}
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
                  profile: {},
                })
              }
              testId="settings-row-preferred-name"
            >
              <PreferredNameControl
                value={userSettings.profile.preferredName}
                onChange={(preferredName) =>
                  saveUserSettings({
                    ...userSettings,
                    profile: preferredName ? { preferredName } : {},
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
              title="Launch behavior"
              description="Choose what dohc opens when the desktop app starts."
              modified={isModified(
                userSettings.general.launchBehavior,
                DEFAULT_USER_SETTINGS.general.launchBehavior,
              )}
              onReset={() =>
                void saveUserSettings({
                  ...userSettings,
                  general: {
                    ...userSettings.general,
                    launchBehavior: DEFAULT_USER_SETTINGS.general.launchBehavior,
                  },
                })
              }
            >
              <SegmentedControl
                label="Launch behavior"
                value={userSettings.general.launchBehavior}
                options={[
                  { value: "last-workspace", label: "Last" },
                  { value: "workspace-picker", label: "Picker" },
                  { value: "new-workspace", label: "New" },
                ]}
                onChange={(launchBehavior) =>
                  void saveUserSettings({
                    ...userSettings,
                    general: { ...userSettings.general, launchBehavior },
                  })
                }
              />
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
