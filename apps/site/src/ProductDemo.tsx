import { Layers } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  SyncStatusResult,
  WorkspaceSummary,
} from "../../desktop/src/ipc/bridgeContract";
import { CommandPalette, type Command } from "../../desktop/src/renderer/CommandPalette";
import { COMMAND_ROWS } from "../../desktop/src/renderer/commands/commandRows";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "../../desktop/src/renderer/editor/MarkdownEditor";
import {
  DocumentControls,
  ViewActions,
} from "../../desktop/src/renderer/fileInspectorUi";
import { PageIdentity } from "../../desktop/src/renderer/PageIdentity";
import { PropertiesPanel } from "../../desktop/src/renderer/PropertiesPanel";
import { QuickOpenPalette } from "../../desktop/src/renderer/QuickOpenPalette";
import { Titlebar } from "../../desktop/src/renderer/Titlebar";
import {
  applyFrontmatter,
  parseFrontmatter,
} from "../../desktop/src/renderer/markdown/frontmatter";
import { ActivityBar } from "../../desktop/src/renderer/workbench/ActivityBar";
import { EditorTabs } from "../../desktop/src/renderer/workbench/EditorTabs";
import { EmptyEditorGroup } from "../../desktop/src/renderer/workbench/EmptyEditorGroup";
import { NoticeCenter } from "../../desktop/src/renderer/workbench/NoticeCenter";
import { EditorGroupFrame } from "../../desktop/src/renderer/workbench/tabRowActions";
import { WorkspaceSyncStatus } from "../../desktop/src/renderer/workbench/WorkspaceSyncStatus";
import { useShellError } from "../../desktop/src/renderer/shell/useShellError";
import { matchShellShortcut } from "../../desktop/src/shortcuts/shortcutRegistry";
import {
  DEMO_EDITOR_GROUP_ID,
  DemoSidebar,
  type DemoWorkspaceDocument,
} from "./DemoSidebar";
import { DEMO_PANEL_IDS, isDemoPanelId, type DemoPanelId } from "./demoPanels";
import {
  configureDemoDesktopBridge,
  DEMO_ASSET_PERSISTENCE_EVENT,
  demoWorkspaceAssetsPersistAcrossSessions,
  resolveDemoWorkspaceAssetUrl,
} from "./demoDesktopBridge";
import {
  collectWorkspacePaths,
  isPathAtOrBelow,
  rewritePathPrefix,
} from "./demoWorkspacePaths";

type DemoDocument = {
  path: string;
  markdown: string;
};

type SaveState = "saved" | "saving";

const STORAGE_KEY = "dohc-marketing-demo-documents-v2";
const FOLDERS_STORAGE_KEY = "dohc-marketing-demo-folders-v1";


const DEMO_WORKSPACE: WorkspaceSummary = {
  workspaceId: "marketing-demo",
  rootPath: "personal",
  kind: "personal",
  mode: "local-first",
};

// The demo keeps every edit in this browser and has no sync to report.
const DEMO_SYNC_STATUS: SyncStatusResult = {
  state: "synced",
  pendingChangeCount: 0,
  lastSyncedAtMs: null,
  historyRecordingUnavailable: false,
  historyShareView: false,
  liveSessionsGeneration: 0,
};

const DEMO_DOCUMENTS: DemoDocument[] = [
  {
    path: "welcome.md",
    markdown: `---
title: Work you can inspect
icon: 📝
---
This is the editor from the desktop app. Edit the document directly.

## Try it

- Select text to format it
- Type **/** on an empty line for commands
- Type **[[** to link another document
- Use Markdown shortcuts to create blocks

> [!note] Your files stay readable
> People and agents work from the same source.

- [x] A real editor
- [ ] Your next document
`,
  },
  {
    path: "projects/launch-plan.md",
    markdown: `---
title: Launch plan
icon: 🚀
---
## Before launch

- [x] Product direction
- [x] Desktop editor
- [ ] First user workspace
- [ ] Publish the story

## Decisions

| Decision | Why |
| --- | --- |
| Local first | The workspace stays on the user's computer |
| Text based | People and agents inspect the same source |
| Individual first | The product must be useful to one person |

Plans change. The record remains.
`,
  },
  {
    path: "research/agent-workflows.md",
    markdown: `---
title: Agent workflows
icon: 🧠
---
## A repeatable loop

1. Write the task
2. Let the agent inspect the workspace
3. Review the proposed changes
4. Save the process as a skill

### The contract

Agents get tools. Users set access, ownership, and review requirements.

\`\`\`text
task -> work -> review -> retained context
\`\`\`
`,
  },
];

function filename(path: string): string {
  return path.split("/").pop() ?? path;
}

function filenameStem(path: string): string {
  return filename(path).replace(/\.md$/i, "");
}

function initialDrafts(): Record<string, string> {
  const defaults = Object.fromEntries(
    DEMO_DOCUMENTS.map((document) => [document.path, document.markdown]),
  );
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return defaults;
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return defaults;
    }
    const restored: Record<string, string> = {};
    for (const [path, markdown] of Object.entries(parsed)) {
      if (
        typeof markdown === "string" &&
        path.endsWith(".md") &&
        !path.split("/").includes("..")
      ) {
        restored[path] = markdown;
      }
    }
    return Object.keys(restored).length > 0 ? restored : defaults;
  } catch {
    // A blocked or malformed localStorage entry should never stop the demo.
  }
  return defaults;
}

function persistDrafts(drafts: Record<string, string>): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
    return true;
  } catch {
    return false;
  }
}

function initialFolders(): string[] {
  try {
    const saved = localStorage.getItem(FOLDERS_STORAGE_KEY);
    if (saved === null) return ["notes"];
    const parsed = JSON.parse(saved) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((folder): folder is string => typeof folder === "string")
      : ["notes"];
  } catch {
    return ["notes"];
  }
}

function persistFolders(folders: string[]): boolean {
  try {
    localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders));
    return true;
  } catch {
    return false;
  }
}

function localStorageIsAvailable(): boolean {
  const key = "dohc-marketing-demo-storage-check";
  try {
    localStorage.setItem(key, key);
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function initialSidebarVisible(): boolean {
  return window.matchMedia("(min-width: 721px)").matches;
}


// The demo records no versions, so it names Main without the picker's menu.
function DemoVersion() {
  return (
    <span
      title="You're working in the Main version"
      className="flex h-7 min-w-0 items-center gap-1.5 px-2 text-[13px] text-muted"
    >
      <Layers size={12} aria-hidden className="shrink-0" />
      <span className="min-w-0 truncate">Main</span>
    </span>
  );
}

const SESSION_ONLY_MESSAGES = {
  workspace: "This browser does not let the demo store files. Your edits last until you close this tab.",
  assets: "This browser does not let the demo store images. Your images last until you close this tab.",
} as const;

// The demo has no editing pipeline, so no tab ever holds a set-aside draft.
const NO_PATHS: ReadonlySet<string> = new Set();

export function ProductDemo() {
  const {
    shellErrors,
    reportShellFailure,
    reportButtonError,
    hideShellError,
    dismissShellError,
  } = useShellError("marketing-demo");
  const reportFailureMessage = useCallback(
    (message: string) => reportShellFailure({ message }),
    [reportShellFailure],
  );
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);
  const [drafts, setDrafts] = useState<Record<string, string>>(initialDrafts);
  const [activePath, setActivePath] = useState(
    () => Object.keys(drafts)[0] ?? DEMO_DOCUMENTS[0].path,
  );
  const [openTabs, setOpenTabs] = useState(() => Object.keys(drafts).slice(0, 5));
  const [recentPaths, setRecentPaths] = useState<string[]>([]);
  const [palette, setPalette] = useState<"commands" | "quick-open" | null>(null);
  const [activeActivity, setActiveActivity] =
    useState<DemoPanelId>("explorer");
  const [sidebarVisible, setSidebarVisible] = useState(initialSidebarVisible);
  const [emptyFolders, setEmptyFolders] = useState<string[]>(initialFolders);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [showSource, setShowSource] = useState(false);
  const [sourceText, setSourceText] = useState("");
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const saveFrame = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const draftsRef = useRef(drafts);
  const sessionOnly = useRef<keyof typeof SESSION_ONLY_MESSAGES | null>(null);

  const updateDrafts = useCallback(
    (update: (current: Record<string, string>) => Record<string, string>) => {
      const next = update(draftsRef.current);
      draftsRef.current = next;
      setDrafts(next);
      return next;
    },
    [],
  );

  // One notice says how long this browser keeps the demo. Losing files
  // outranks losing images, so a later image notice never replaces it.
  const reportSessionOnly = useCallback(
    (scope: keyof typeof SESSION_ONLY_MESSAGES) => {
      if (sessionOnly.current === "workspace" || sessionOnly.current === scope) return;
      sessionOnly.current = scope;
      reportShellFailure({
        tone: "warning",
        identity: "demo-storage",
        message: SESSION_ONLY_MESSAGES[scope],
      });
    },
    [reportShellFailure],
  );

  const editorOpen = openTabs.includes(activePath);
  const activeFullText = drafts[activePath] ?? "";
  const activeBody = parseFrontmatter(activeFullText).body;
  const documents = useMemo<DemoWorkspaceDocument[]>(
    () =>
      Object.entries(drafts)
        .map(([path, markdown]) => {
          const parsed = parseFrontmatter(markdown);
          return {
            path,
            title: String(parsed.meta.title ?? filenameStem(path)),
            body: parsed.body,
            ...(typeof parsed.meta.icon === "string"
              ? { icon: parsed.meta.icon }
              : {}),
          };
        })
        .sort((left, right) => left.path.localeCompare(right.path)),
    [drafts],
  );
  const knownFiles = useMemo(
    () =>
      documents.map((document) => ({
        path: document.path,
        title: document.title,
      })),
    [documents],
  );
  const fileEntries = useMemo(
    () =>
      new Map(
        documents.map((document) => [
          document.path,
          {
            path: document.path,
            kind: "file" as const,
            ...(document.icon ? { icon: document.icon } : {}),
          },
        ]),
      ),
    [documents],
  );

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!localStorageIsAvailable()) reportSessionOnly("workspace");
    if (!demoWorkspaceAssetsPersistAcrossSessions()) reportSessionOnly("assets");
    const markSessionOnly = () => reportSessionOnly("assets");
    window.addEventListener(DEMO_ASSET_PERSISTENCE_EVENT, markSessionOnly);
    return () =>
      window.removeEventListener(DEMO_ASSET_PERSISTENCE_EVENT, markSessionOnly);
  }, [reportSessionOnly]);

  useEffect(
    () => () => {
      if (saveFrame.current !== null) cancelAnimationFrame(saveFrame.current);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!persistDrafts(drafts)) reportSessionOnly("workspace");
  }, [drafts, reportSessionOnly]);

  useEffect(() => {
    if (!persistFolders(emptyFolders)) reportSessionOnly("workspace");
  }, [emptyFolders, reportSessionOnly]);

  const composeCurrentDocument = useCallback(
    (path = activePath, fallback = drafts[path] ?? "") => {
      const editorMarkdown =
        path === activePath ? editorRef.current?.getMarkdown() : null;
      const body = editorMarkdown ?? parseFrontmatter(fallback).body;
      return applyFrontmatter(body, parseFrontmatter(fallback).meta);
    },
    [activePath, drafts],
  );

  const storeDraft = useCallback((path: string, markdown: string) => {
    updateDrafts((current) => ({ ...current, [path]: markdown }));
  }, [updateDrafts]);

  const cancelPendingSave = useCallback(() => {
    if (saveFrame.current === null) return;
    cancelAnimationFrame(saveFrame.current);
    saveFrame.current = null;
  }, []);

  // Stores the open editor's text before it closes or another document
  // replaces it, so no edit waits on a frame that never comes.
  const flushActiveDraft = useCallback(() => {
    cancelPendingSave();
    if (editorOpen) storeDraft(activePath, composeCurrentDocument());
    setSaveState("saved");
  }, [activePath, cancelPendingSave, composeCurrentDocument, editorOpen, storeDraft]);

  const scheduleSave = useCallback(() => {
    setSaveState("saving");
    if (saveFrame.current !== null) cancelAnimationFrame(saveFrame.current);
    const path = activePath;
    const markdown = composeCurrentDocument(path);
    saveFrame.current = requestAnimationFrame(() => {
      saveFrame.current = null;
      storeDraft(path, markdown);
    });
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      setSaveState("saved");
      saveTimer.current = null;
    }, 650);
  }, [activePath, composeCurrentDocument, storeDraft]);

  const showDocument = useCallback((path: string) => {
    setOpenTabs((current) => (current.includes(path) ? current : [...current, path]));
    setRecentPaths((current) => [path, ...current.filter((entry) => entry !== path)].slice(0, 20));
    setShowSource(false);
    setActivePath(path);
    setSaveState("saved");
  }, []);

  const openDocument = useCallback(
    (path: string) => {
      if (path === activePath && editorOpen) return;
      flushActiveDraft();
      showDocument(path);
    },
    [activePath, editorOpen, flushActiveDraft, showDocument],
  );

  // Closing the active tab shows its neighbour, as the desktop does; closing
  // the last one leaves the group empty.
  const closeTab = useCallback(
    (path: string) => {
      const index = openTabs.indexOf(path);
      if (index < 0) return;
      const remaining = openTabs.filter((tab) => tab !== path);
      if (path === activePath) {
        flushActiveDraft();
        setShowSource(false);
        const next = remaining[Math.min(index, remaining.length - 1)];
        if (next) setActivePath(next);
      }
      setOpenTabs(remaining);
    },
    [activePath, flushActiveDraft, openTabs],
  );

  const closeAllTabs = useCallback(() => {
    flushActiveDraft();
    setShowSource(false);
    setOpenTabs([]);
  }, [flushActiveDraft]);

  const moveTab = useCallback((path: string, toIndex: number) => {
    setOpenTabs((current) => {
      const next = current.filter((tab) => tab !== path);
      next.splice(toIndex, 0, path);
      return next;
    });
  }, []);

  const openWikilink = useCallback(
    (target: string) => {
      const normalized = target.replace(/\.md$/i, "");
      const match =
        knownFiles.find(
          (file) => file.path.replace(/\.md$/i, "") === normalized,
        ) ?? knownFiles.find((file) => file.path === target);
      openDocument(match?.path ?? `${normalized}.md`);
    },
    [knownFiles, openDocument],
  );

  const createDocument = useCallback(() => {
    flushActiveDraft();
    const workspacePaths = new Set(
      collectWorkspacePaths([
        ...Object.keys(draftsRef.current),
        ...emptyFolders,
      ]),
    );
    let index = 1;
    let path = "notes/quick-note.md";
    while (workspacePaths.has(path)) {
      index += 1;
      path = `notes/quick-note-${index}.md`;
    }
    storeDraft(
      path,
      `---\ntitle: Quick note ${index}\nicon: 📝\n---\nStart writing here. Type **/** for commands or **[[** to link another page.\n`,
    );
    showDocument(path);
  }, [emptyFolders, flushActiveDraft, showDocument, storeDraft]);

  const createDocumentAtPath = useCallback(
    (path: string) => {
      const title = filenameStem(path)
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
      storeDraft(
        path,
        `---\ntitle: ${title}\nicon: 📝\n---\nStart writing here. Type **/** for commands or **[[** to link another page.\n`,
      );
      // Explorer calls onOpenFile immediately after the bridge resolves, before
      // React has published the new documents prop. Select it here so the new
      // file still opens in that same interaction.
      showDocument(path);
    },
    [showDocument, storeDraft],
  );

  const moveDraftPath = useCallback((fromPath: string, toPath: string) => {
    updateDrafts((current) => {
      return Object.fromEntries(
        Object.entries(current).map(([path, markdown]) => [
          rewritePathPrefix(path, fromPath, toPath),
          markdown,
        ]),
      );
    });
    setActivePath((current) =>
      rewritePathPrefix(current, fromPath, toPath),
    );
    setEmptyFolders((current) =>
      current.map((path) => rewritePathPrefix(path, fromPath, toPath)),
    );
  }, [updateDrafts]);

  const deleteDraftPath = useCallback((path: string) => {
    const next = updateDrafts((current) => {
      const filtered = Object.fromEntries(
        Object.entries(current).filter(
          ([entry]) => !isPathAtOrBelow(entry, path),
        ),
      );
      if (Object.keys(filtered).length === 0) {
        const fallback = DEMO_DOCUMENTS[0];
        filtered[fallback.path] = fallback.markdown;
      }
      return filtered;
    });
    const remainingTabs = openTabs.filter((tab) => !isPathAtOrBelow(tab, path));
    setOpenTabs(remainingTabs);
    if (isPathAtOrBelow(activePath, path)) {
      // The next open tab takes over, as when the tab closes; with none left
      // the editor group is empty.
      const index = Math.max(0, openTabs.indexOf(activePath));
      setActivePath(
        remainingTabs[Math.min(index, remainingTabs.length - 1)] ??
          Object.keys(next)[0] ??
          DEMO_DOCUMENTS[0].path,
      );
      setShowSource(false);
      setSourceText("");
    }
    setEmptyFolders((current) =>
      current.filter((entry) => entry !== path && !entry.startsWith(`${path}/`)),
    );
  }, [activePath, openTabs, updateDrafts]);

  const updateIdentity = useCallback(
    (nextFullText: string) => {
      cancelPendingSave();
      const next = applyFrontmatter(
        editorRef.current?.getMarkdown() ?? activeBody,
        parseFrontmatter(nextFullText).meta,
      );
      storeDraft(activePath, next);
      setSaveState("saving");
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        setSaveState("saved");
        saveTimer.current = null;
      }, 650);
    },
    [activeBody, activePath, cancelPendingSave, storeDraft],
  );

  const toggleSource = useCallback(() => {
    if (!showSource) {
      cancelPendingSave();
      const next = composeCurrentDocument();
      storeDraft(activePath, next);
      setSourceText(next);
    }
    setShowSource((current) => !current);
  }, [
    activePath,
    cancelPendingSave,
    composeCurrentDocument,
    showSource,
    storeDraft,
  ]);

  const selectActivity = useCallback(
    (next: DemoPanelId) => {
      if (next === activeActivity) {
        setSidebarVisible((current) => !current);
        return;
      }
      setActiveActivity(next);
      setSidebarVisible(true);
    },
    [activeActivity],
  );

  const toggleSidebar = useCallback(() => setSidebarVisible((current) => !current), []);

  const showNeighbourTab = useCallback(
    (step: 1 | -1) => {
      const index = openTabs.indexOf(activePath);
      const next = openTabs[(index + step + openTabs.length) % openTabs.length];
      if (next) openDocument(next);
    },
    [activePath, openDocument, openTabs],
  );

  // The desktop's commands the demo can run, under the desktop's names.
  const commands = useMemo<Command[]>(() => {
    const command = (id: keyof typeof COMMAND_ROWS, run: () => void) => ({
      id,
      label: COMMAND_ROWS[id].label,
      run,
    });
    return [
      command("new-file", createDocument),
      command("quick-open", () => setPalette("quick-open")),
      command("toggle-sidebar", toggleSidebar),
      ...(editorOpen
        ? [
            command("close-tab", () => closeTab(activePath)),
            command("toggle-markdown-source", toggleSource),
          ]
        : []),
      ...(openTabs.length > 1
        ? [
            command("next-tab", () => showNeighbourTab(1)),
            command("previous-tab", () => showNeighbourTab(-1)),
          ]
        : []),
      ...DEMO_PANEL_IDS.map((view) =>
        command(`show-${view}`, () => {
          setActiveActivity(view);
          setSidebarVisible(true);
        }),
      ),
    ];
  }, [
    activePath,
    closeTab,
    createDocument,
    editorOpen,
    openTabs.length,
    showNeighbourTab,
    toggleSidebar,
    toggleSource,
  ]);

  // Shell shortcuts work while focus is in the demo. A browser keeps some
  // for itself, such as closing its own tab.
  const runShortcut = useCallback(
    (event: React.KeyboardEvent) => {
      const id = matchShellShortcut(event.nativeEvent, window.dohcDesktop?.platform);
      const run =
        id === "command-palette" ? () => setPalette("commands")
        : id === "quick-open" ? () => setPalette("quick-open")
        : id === "toggle-sidebar" ? toggleSidebar
        : id === "new-file" ? createDocument
        : id === "close-tab" && editorOpen ? () => closeTab(activePath)
        : id === "next-tab" ? () => showNeighbourTab(1)
        : id === "previous-tab" ? () => showNeighbourTab(-1)
        : null;
      if (!run) return;
      event.preventDefault();
      run();
    },
    [activePath, closeTab, createDocument, editorOpen, showNeighbourTab, toggleSidebar],
  );

  const createFolder = useCallback((path: string) => {
    setEmptyFolders((current) =>
      current.includes(path) ? current : [...current, path],
    );
  }, []);

  useLayoutEffect(() => {
    configureDemoDesktopBridge({
      documents,
      folders: emptyFolders,
      createFile: createDocumentAtPath,
      createFolder,
      movePath: moveDraftPath,
      deletePath: deleteDraftPath,
    });
  }, [
    createDocumentAtPath,
    createFolder,
    deleteDraftPath,
    documents,
    emptyFolders,
    moveDraftPath,
  ]);

  return (
    <div
      className="demo-window"
      data-theme={theme}
      data-sidebar-visible={sidebarVisible}
      onKeyDown={runShortcut}
    >
      <Titlebar
        workspace={DEMO_WORKSPACE}
        workspaces={[DEMO_WORKSPACE]}
        onSwitchWorkspace={() => undefined}
        onQuickOpen={() => setPalette("quick-open")}
        version={<DemoVersion />}
        workspaceStatus={
          <WorkspaceSyncStatus syncStatus={DEMO_SYNC_STATUS} failedSaves={0} />
        }
        primarySidebar={{ visible: sidebarVisible, onToggle: toggleSidebar }}
      />
      <span className="demo-window-controls" aria-hidden>
        <span className="demo-window-control" />
        <span className="demo-window-control" />
        <span className="demo-window-control" />
      </span>

      <div className="demo-workbench">
        <ActivityBar
          views={DEMO_PANEL_IDS}
          activeView={activeActivity}
          sidebarVisible={sidebarVisible}
          hasConflict={false}
          showSharing={false}
          onSelectView={(view) => {
            if (isDemoPanelId(view)) selectActivity(view);
          }}
          notices={
            <NoticeCenter
              workspaceId="marketing-demo"
              syncStatus={null}
              agentActive={false}
              conflictSummaries={[]}
              onOpenHistory={() => selectActivity("history")}
              onOpenSettings={() => undefined}
              onOpenConflicts={() => undefined}
              onRefreshShareView={() => undefined}
              onRebuildEngineStore={() => undefined}
              workspaceErrors={shellErrors.map((error) => ({
                ...error,
                details: error.message,
                canRetry: false,
              }))}
              onHideWorkspaceError={hideShellError}
              onDismissWorkspaceError={dismissShellError}
            />
          }
        />

        <DemoSidebar
          activePanel={activeActivity}
          visible={sidebarVisible}
          documents={documents}
          folders={emptyFolders}
          activePath={editorOpen ? activePath : null}
          openTabs={openTabs}
          onOpenDocument={openDocument}
          onCloseTab={closeTab}
          onCloseAllTabs={closeAllTabs}
          onOpenTabsChange={setOpenTabs}
          onCreateDocument={createDocument}
          onBeforeChanges={async () => flushActiveDraft()}
          onError={reportFailureMessage}
        />

        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          <EditorGroupFrame
            tabs={(actionsRef) => (
              <EditorTabs
                actionsRef={actionsRef}
                groupId={DEMO_EDITOR_GROUP_ID}
                groupNumber={1}
                tabs={openTabs.map((path) => ({ path }))}
                activeTab={editorOpen ? activePath : null}
                activeTabDirty={saveState === "saving"}
                files={fileEntries}
                recoveryPaths={NO_PATHS}
                onActivate={(_groupId, path) => openDocument(path)}
                onClose={(_groupId, path) => closeTab(path)}
                onContextMenu={() => undefined}
                onMove={(_groupId, path, toIndex) => moveTab(path, toIndex)}
                onMoveToGroup={() => undefined}
                onCreateGroupRight={() => undefined}
              />
            )}
          >
            {editorOpen ? (
              <>
                <ViewActions
                  actions={
                    <DocumentControls
                      toggle={{
                        label: showSource ? "WYSIWYG" : "Source",
                        testId: "markdown-edit-toggle",
                        onClick: toggleSource,
                      }}
                      menu={{
                        workspaceId: "marketing-demo",
                        suggestedName: filenameStem(activePath),
                        reportError: reportButtonError,
                        getMarkdown: () => composeCurrentDocument(),
                      }}
                    />
                  }
                />
                {showSource ? (
                  <textarea
                    className="demo-source"
                    value={sourceText}
                    readOnly
                    spellCheck={false}
                    aria-label="Read-only markdown source"
                  />
                ) : null}
                <div
                  className="min-h-0 flex-1 overflow-auto bg-bg text-[length:var(--dohc-editor-font-size)] [scrollbar-gutter:stable]"
                  data-dohc-doc-pane=""
                  hidden={showSource}
                >
                  <div className="group/topmatter">
                    <PageIdentity
                      body={activeFullText}
                      onChange={updateIdentity}
                      filenameStem={filenameStem(activePath)}
                      onEnterBody={() => editorRef.current?.focus("start")}
                    />
                    <PropertiesPanel body={activeFullText} onChange={updateIdentity} onShowSource={toggleSource} />
                  </div>
                  <MarkdownEditor
                    key={activePath}
                    ref={editorRef}
                    value={activeBody}
                    onDirty={scheduleSave}
                    workspaceId="marketing-demo"
                    path={activePath}
                    knownFiles={knownFiles}
                    onOpenWikilink={openWikilink}
                    resolveWorkspaceAssetUrl={resolveDemoWorkspaceAssetUrl}
                    collab={null}
                  />
                </div>
              </>
            ) : (
              <EmptyEditorGroup
                platform={window.dohcDesktop?.platform}
                create={{ markdown: createDocument }}
                recent={recentPaths}
                files={documents}
                onOpen={openDocument}
              />
            )}
          </EditorGroupFrame>
        </main>
      </div>
      {palette ? (
        <div className="demo-overlay">
          {palette === "quick-open" ? (
            <QuickOpenPalette
              files={documents}
              recent={recentPaths}
              pinned={[]}
              onOpenPath={openDocument}
              onClose={() => setPalette(null)}
            />
          ) : (
            <CommandPalette
              testId="command-palette"
              toggleShortcut="command-palette"
              commands={commands}
              onClose={() => setPalette(null)}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
