import {
  AlertTriangle,
  CheckCircle2,
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
import {
  DEFAULT_USER_SETTINGS,
  type DesktopUserSettings,
  type DesktopUserSettingsResult,
} from "../../settings/userSettings";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  mergeWorkspaceSettings,
  type WorkspaceSettings,
  type WorkspaceSettingsResult,
} from "../../workspaces/workspaceSettings";
import { bridge } from "../bridge";
import { applyAppearanceSettings } from "../theme";
import { AgentsMcpSettings } from "./AgentsMcpSettings";
import { SegmentedControl, SettingRow, SwitchControl } from "./SettingRow";
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
  initialSection?: SettingsSectionId;
  onClose: () => void;
  onAgentActiveChange?: (active: boolean) => void;
  onOpenCloud?: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(
    props.initialSection ?? DEFAULT_SETTINGS_SECTION,
  );
  const [query, setQuery] = useState("");
  const [userResult, setUserResult] = useState<DesktopUserSettingsResult | null>(null);
  const [workspaceResult, setWorkspaceResult] =
    useState<WorkspaceSettingsResult | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    if (props.initialSection) setActiveSection(props.initialSection);
  }, [props.initialSection]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      bridge().getUserSettings(),
      bridge().getWorkspaceSettings({ workspaceId: props.workspaceId }),
    ])
      .then(([nextUser, nextWorkspace]) => {
        if (cancelled) return;
        setUserResult(nextUser);
        setWorkspaceResult(nextWorkspace);
        applyAppearanceSettings(nextUser.settings.appearance);
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
      setUserResult(saved);
      markSaved();
    } catch (cause) {
      setSaveState("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [markSaved, markSaving]);

  const saveWorkspaceSettings = useCallback(
    async (settings: WorkspaceSettings) => {
      setWorkspaceResult((current) => ({
        settings,
        source: current?.source ?? "default",
        ...(current?.warning ? { warning: current.warning } : {}),
      }));
      markSaving();
      setError(null);
      try {
        const saved = await bridge().setWorkspaceSettings({
          workspaceId: props.workspaceId,
          settings,
        });
        setWorkspaceResult(saved);
        markSaved();
      } catch (cause) {
        setSaveState("error");
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [markSaved, markSaving, props.workspaceId],
  );

  const resetUserSettings = useCallback(async () => {
    markSaving();
    setError(null);
    try {
      const next = await bridge().resetUserSettings();
      setUserResult(next);
      applyAppearanceSettings(next.settings.appearance);
      markSaved();
    } catch (cause) {
      setSaveState("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [markSaved, markSaving]);

  const resetWorkspaceSettings = useCallback(async () => {
    markSaving();
    setError(null);
    try {
      const next = await bridge().resetWorkspaceSettings({
        workspaceId: props.workspaceId,
      });
      setWorkspaceResult(next);
      markSaved();
    } catch (cause) {
      setSaveState("error");
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [markSaved, markSaving, props.workspaceId]);

  const userSettings = userResult?.settings ?? DEFAULT_USER_SETTINGS;
  const workspaceSettings = workspaceResult?.settings ?? DEFAULT_WORKSPACE_SETTINGS;
  const activeMeta =
    SETTINGS_SECTIONS.find((section) => section.id === activeSection) ??
    SETTINGS_SECTIONS[0];

  const warnings = [
    userResult?.warning,
    workspaceResult?.warning,
    error ? `Settings error: ${error}` : null,
  ].filter((message): message is string => Boolean(message));

  const renderSection = () => {
    if (query.trim() && filteredSections.length === 0) {
      return (
        <div
          data-testid="settings-empty-search"
          className="flex h-40 items-center justify-center rounded border border-dashed border-line text-sm text-muted"
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
                className="rounded bg-accent px-3 py-1 text-xs text-bg disabled:opacity-50"
                disabled={!props.onOpenCloud}
              >
                Open Cloud
              </button>
            </SettingRow>
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
                void saveWorkspaceSettings(mergeWorkspaceSettings(workspaceSettings, {
                  privacy: {
                    ...workspaceSettings.privacy,
                    confirmExternalLinks:
                      DEFAULT_WORKSPACE_SETTINGS.privacy.confirmExternalLinks,
                  },
                }))
              }
            >
              <SwitchControl
                label="Confirm external links"
                checked={workspaceSettings.privacy.confirmExternalLinks}
                onChange={(confirmExternalLinks) =>
                  void saveWorkspaceSettings(mergeWorkspaceSettings(workspaceSettings, {
                    privacy: { ...workspaceSettings.privacy, confirmExternalLinks },
                  }))
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
              <kbd className="rounded bg-panel-2 px-2 py-1 text-[11px] text-ink">
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
              onReset={() => void resetUserSettings()}
            >
              <button
                type="button"
                onClick={() => void resetUserSettings()}
                className="rounded border border-line px-3 py-1 text-xs text-muted hover:bg-panel-2 hover:text-ink"
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
                className="rounded border border-line px-3 py-1 text-xs text-muted hover:bg-panel-2 hover:text-ink"
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
              title="Current workspace"
              description="Settings in the Workspace scope apply only to this registered local folder."
              testId="settings-row-current-workspace"
            >
              <code className="max-w-sm truncate rounded bg-panel-2 px-2 py-1 text-xs text-ink">
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
          </div>
        );
    }
  };

  const visibleSections = query.trim() ? filteredSections : SETTINGS_SECTIONS;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      data-testid="settings-dialog"
      data-active-section={activeSection}
      className="flex h-[min(760px,calc(100vh-48px))] w-[min(1040px,calc(100vw-32px))] overflow-hidden rounded-lg border border-line bg-bg shadow-2xl"
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
              className={`flex items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] ${
                activeSection === section.id
                  ? "bg-bg text-ink"
                  : "text-muted hover:bg-panel-2 hover:text-ink"
              }`}
            >
              <section.Icon size={15} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{section.label}</span>
              <span className="text-[10px] text-subtle">{section.scope}</span>
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
              data-testid="settings-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search settings"
              className="h-8 w-full rounded-md border border-line bg-panel pl-8 pr-3 text-[12px] text-ink outline-none placeholder:text-subtle focus:border-ink"
            />
          </div>
          <StatusPill state={saveState} />
          <button
            ref={closeRef}
            type="button"
            aria-label="Close settings"
            onClick={props.onClose}
            className="grid size-8 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-ink"
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
            className="h-8 w-full rounded border border-line bg-panel px-2 text-xs text-ink"
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
          <div className="mb-5 flex items-end justify-between gap-4">
            <div>
              <h3 className="m-0 text-base font-semibold text-ink">
                {activeMeta.label}
              </h3>
              <p className="m-0 mt-1 text-[11px] text-subtle">
                Scope: {activeMeta.scope}
              </p>
            </div>
          </div>
          {renderSection()}
        </section>
      </main>
    </div>
  );
}
