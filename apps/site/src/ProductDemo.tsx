import { Layers } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { SyncStatusResult, WorkspaceSummary } from "../../desktop/src/ipc/bridgeContract";
import {
  admitCollectionChanges,
  openCollectionChangeShell,
} from "../../desktop/src/renderer/collectionChangeShells";
import { CommandPalette, type Command } from "../../desktop/src/renderer/CommandPalette";
import { COMMAND_ROWS } from "../../desktop/src/renderer/commands/commandRows";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "../../desktop/src/renderer/editor/MarkdownEditor";
import { DocumentControls, ViewActions } from "../../desktop/src/renderer/fileInspectorUi";
import { PageIdentity } from "../../desktop/src/renderer/PageIdentity";
import { PropertiesPanel } from "../../desktop/src/renderer/PropertiesPanel";
import { QuickOpenPalette } from "../../desktop/src/renderer/QuickOpenPalette";
import { Titlebar } from "../../desktop/src/renderer/Titlebar";
import { DeleteCollectionRecordDialog } from "../../desktop/src/renderer/DeleteCollectionRecordDialog";
import { TransactionalCollectionPage } from "../../desktop/src/renderer/TransactionalCollectionPage";
import { Menu, MENU_SEPARATOR, type MenuEntry } from "../../desktop/src/renderer/ui/Menu";
import {
  applyFrontmatter,
  parseFrontmatter,
} from "../../desktop/src/renderer/markdown/frontmatter";
import { ActivityBar } from "../../desktop/src/renderer/workbench/ActivityBar";
import { EditorTabs } from "../../desktop/src/renderer/workbench/EditorTabs";
import { EmptyEditorGroup } from "../../desktop/src/renderer/workbench/EmptyEditorGroup";
import { NoticeCenter } from "../../desktop/src/renderer/workbench/NoticeCenter";
import { EditorGroupFrame } from "../../desktop/src/renderer/workbench/tabRowActions";
import {
  siteTabPath,
  transactionalCollectionTabPath,
} from "../../desktop/src/renderer/workbench/workbenchState";
import { WorkspaceSyncStatus } from "../../desktop/src/renderer/workbench/WorkspaceSyncStatus";
import {
  ShellErrorReporter,
  ShellNoticeClear,
  useShellError,
} from "../../desktop/src/renderer/shell/useShellError";
import { WorkspaceSessionProvider } from "../../desktop/src/renderer/workspace/workspaceSession";
import { matchShellShortcut } from "../../desktop/src/shortcuts/shortcutRegistry";
import { DEMO_EDITOR_GROUP_ID, DemoSidebar, type DemoWorkspaceDocument } from "./DemoSidebar";
import {
  DEMO_GUESTS,
  demoCollectionStore,
  GUESTS_DATASET,
  GUESTS_DATASET_PATH,
  GUESTS_TABLE_ID,
  isDemoRecordList,
  type DemoRecord,
} from "./demoCollection";
import { DEMO_PANEL_IDS, isDemoPanelId, type DemoPanelId } from "./demoPanels";
import {
  configureDemoDesktopBridge,
  DEMO_ASSET_PERSISTENCE_EVENT,
  demoWorkspaceAssetsPersistAcrossSessions,
  resolveDemoWorkspaceAssetUrl,
} from "./demoDesktopBridge";
import {
  APP_ENTRY,
  APP_ROOT,
  APP_SOURCE,
  APP_TITLE,
  appDocument,
  DEMO_PAGES,
  DEMO_PINNED_PAGES,
  DEMO_WORKSPACE_NAME,
} from "./demoWorkspace";
import {
  collectWorkspacePaths,
  isPathAtOrBelow,
  resolveDemoWikilink,
  rewritePathPrefix,
} from "./demoWorkspacePaths";

type SaveState = "saved" | "saving";

const STORAGE_KEY = "dohc-marketing-demo-pages-v3";
const FOLDERS_STORAGE_KEY = "dohc-marketing-demo-folders-v2";
const GUESTS_STORAGE_KEY = "dohc-marketing-demo-guests-v1";
const WORKSPACE_ID = "marketing-demo";

const DEMO_WORKSPACE: WorkspaceSummary = {
  workspaceId: WORKSPACE_ID,
  rootPath: DEMO_WORKSPACE_NAME,
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

export const APP_TAB = siteTabPath(APP_ROOT);
export const COLLECTION_TAB = transactionalCollectionTabPath(GUESTS_DATASET_PATH, GUESTS_TABLE_ID);
const TAB_LABELS: ReadonlyMap<string, string> = new Map([
  [APP_TAB, APP_TITLE],
  [COLLECTION_TAB, GUESTS_DATASET.name],
]);

type TabKind = "page" | "app" | "collection" | "app-source";

function tabKind(path: string): TabKind {
  if (path === APP_TAB) return "app";
  if (path === COLLECTION_TAB) return "collection";
  if (path === APP_ENTRY) return "app-source";
  return "page";
}

function filename(path: string): string {
  return path.split("/").pop() ?? path;
}

function filenameStem(path: string): string {
  return filename(path).replace(/\.md$/i, "");
}

function readStored(key: string): unknown {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? undefined : (JSON.parse(stored) as unknown);
  } catch {
    // A blocked or malformed localStorage entry should never stop the demo.
    return undefined;
  }
}

function writeStored(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function initialDrafts(): Record<string, string> {
  const defaults = Object.fromEntries(DEMO_PAGES.map((page) => [page.path, page.markdown]));
  const parsed = readStored(STORAGE_KEY);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
  const restored: Record<string, string> = {};
  for (const [path, markdown] of Object.entries(parsed)) {
    if (typeof markdown === "string" && path.endsWith(".md") && !path.split("/").includes("..")) {
      restored[path] = markdown;
    }
  }
  return Object.keys(restored).length > 0 ? restored : defaults;
}

function initialFolders(): string[] {
  const parsed = readStored(FOLDERS_STORAGE_KEY);
  return Array.isArray(parsed)
    ? parsed.filter((folder): folder is string => typeof folder === "string")
    : [];
}

function initialGuests(): readonly DemoRecord[] {
  const parsed = readStored(GUESTS_STORAGE_KEY);
  return isDemoRecordList(parsed) ? parsed : DEMO_GUESTS;
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

// At this width the sidebar lies over the whole editor (demo.css).
function sidebarCoversEditor(): boolean {
  return window.matchMedia("(max-width: 720px)").matches;
}

// The app keeps its state when the page's theme changes: its document stays
// as it loaded, and the theme arrives as a message.
function DemoAppFrame(props: { theme: "light" | "dark"; hidden: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [srcDoc] = useState(() => appDocument(props.theme));
  const sendTheme = useCallback(
    () => frame.current?.contentWindow?.postMessage({ dohcTheme: props.theme }, "*"),
    [props.theme],
  );
  useEffect(sendTheme, [sendTheme]);
  return (
    <iframe
      ref={frame}
      title={APP_TITLE}
      hidden={props.hidden}
      sandbox="allow-scripts allow-forms"
      srcDoc={srcDoc}
      onLoad={sendTheme}
      className="demo-app min-h-0 flex-1 border-0 bg-bg"
    />
  );
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
  workspace:
    "This browser does not let the demo store files. Your edits last until you close this tab.",
  assets:
    "This browser does not let the demo store images. Your images last until you close this tab.",
} as const;

// The demo has no editing pipeline, so no tab ever holds a set-aside draft.
const NO_PATHS: ReadonlySet<string> = new Set();

function ProductDemoWindow() {
  const {
    shellErrors,
    reportShellFailure,
    hideShellError,
    dismissShellError,
    retryShellError,
    runShellErrorAction,
    clearIdentity,
    showSuccessNotice,
  } = useShellError(WORKSPACE_ID);
  const reportFailureMessage = useCallback(
    (message: string) => reportShellFailure({ message }),
    [reportShellFailure],
  );
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);
  const [drafts, setDrafts] = useState<Record<string, string>>(initialDrafts);
  const [activePath, setActivePath] = useState(() => Object.keys(drafts)[0] ?? DEMO_PAGES[0].path);
  const [openTabs, setOpenTabs] = useState(() => [
    ...Object.keys(drafts).slice(0, 1),
    APP_TAB,
    COLLECTION_TAB,
  ]);
  const [recentPaths, setRecentPaths] = useState<string[]>([]);
  const [palette, setPalette] = useState<"commands" | "quick-open" | null>(null);
  const [activeActivity, setActiveActivity] = useState<DemoPanelId>("explorer");
  const [sidebarVisible, setSidebarVisible] = useState(initialSidebarVisible);
  const [emptyFolders, setEmptyFolders] = useState<string[]>(initialFolders);
  const [pinnedPages, setPinnedPages] = useState<string[]>(DEMO_PINNED_PAGES);
  const [pinnedApps, setPinnedApps] = useState<string[]>([APP_ROOT]);
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

  const [guests] = useState(() =>
    demoCollectionStore(initialGuests(), (records) => {
      if (!writeStored(GUESTS_STORAGE_KEY, records)) reportSessionOnly("workspace");
    }),
  );
  const [deletion, setDeletion] = useState<{
    recordId: string | number;
    answer(confirmed: boolean): void;
  } | null>(null);

  // Shell shortcuts only reach the demo while focus is inside it. When the
  // focused control unmounts, such as a closed menu or palette, the browser
  // drops focus to the page, so the window takes it back. A press on the page
  // leaves focus there, even when it closed a menu. React skips the focusout
  // of a node it is removing, so this listens on the demo's root.
  const windowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const demo = windowRef.current;
    const root = demo?.getRootNode();
    if (!demo || !root) return;
    let pressedOutside = false;
    const notePress = (event: PointerEvent) => {
      pressedOutside = !event.composedPath().includes(root);
    };
    const keepFocusInside = (event: Event) => {
      const left = event.target;
      if (!(event instanceof FocusEvent) || event.relatedTarget !== null) return;
      if (!(left instanceof Node)) return;
      window.setTimeout(() => {
        if (!pressedOutside && !left.isConnected && document.activeElement === document.body)
          demo.focus({ preventScroll: true });
      });
    };
    const noteFocusInside = () => {
      pressedOutside = false;
    };
    document.addEventListener("pointerdown", notePress, true);
    root.addEventListener("focusout", keepFocusInside);
    root.addEventListener("focusin", noteFocusInside);
    return () => {
      document.removeEventListener("pointerdown", notePress, true);
      root.removeEventListener("focusout", keepFocusInside);
      root.removeEventListener("focusin", noteFocusInside);
    };
  }, []);

  const activeTab = openTabs.includes(activePath) ? activePath : null;
  const activeKind = activeTab === null ? null : tabKind(activeTab);
  const pageOpen = activeKind === "page";
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
            ...(typeof parsed.meta.icon === "string" ? { icon: parsed.meta.icon } : {}),
          };
        })
        .sort((left, right) => left.path.localeCompare(right.path)),
    [drafts],
  );
  const knownFiles = useMemo(
    () => documents.map((document) => ({ path: document.path, title: document.title })),
    [documents],
  );
  const workspaceFiles = useMemo(
    () => [...documents, { path: APP_ENTRY }, { path: GUESTS_DATASET_PATH }],
    [documents],
  );
  const fileEntries = useMemo(
    () =>
      new Map(
        workspaceFiles.map((file) => [
          file.path,
          {
            path: file.path,
            kind: "file" as const,
            ...("icon" in file && file.icon ? { icon: file.icon } : {}),
          },
        ]),
      ),
    [workspaceFiles],
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
    return () => window.removeEventListener(DEMO_ASSET_PERSISTENCE_EVENT, markSessionOnly);
  }, [reportSessionOnly]);

  useEffect(() => {
    const close = openCollectionChangeShell(WORKSPACE_ID, {
      onError: (fallback, error, retry, identity, quiet, onDismiss) =>
        reportShellFailure({
          message: fallback,
          cause: error,
          retry,
          ...(identity !== undefined ? { identity } : {}),
          ...(quiet ? { quiet } : {}),
          ...(onDismiss ? { onDismiss } : {}),
        }),
      onSettled: clearIdentity,
      onNotice: (message) => reportShellFailure({ tone: "success", message }),
    });
    const end = admitCollectionChanges(WORKSPACE_ID);
    return () => {
      end();
      close();
    };
  }, [clearIdentity, reportShellFailure]);

  useEffect(
    () => () => {
      if (saveFrame.current !== null) cancelAnimationFrame(saveFrame.current);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!writeStored(STORAGE_KEY, drafts)) reportSessionOnly("workspace");
  }, [drafts, reportSessionOnly]);

  useEffect(() => {
    if (!writeStored(FOLDERS_STORAGE_KEY, emptyFolders)) reportSessionOnly("workspace");
  }, [emptyFolders, reportSessionOnly]);

  const composeCurrentDocument = useCallback(
    (path = activePath, fallback = drafts[path] ?? "") => {
      const editorMarkdown = path === activePath ? editorRef.current?.getMarkdown() : null;
      const body = editorMarkdown ?? parseFrontmatter(fallback).body;
      return applyFrontmatter(body, parseFrontmatter(fallback).meta);
    },
    [activePath, drafts],
  );

  const storeDraft = useCallback(
    (path: string, markdown: string) => {
      updateDrafts((current) => ({ ...current, [path]: markdown }));
    },
    [updateDrafts],
  );

  const cancelPendingSave = useCallback(() => {
    if (saveFrame.current === null) return;
    cancelAnimationFrame(saveFrame.current);
    saveFrame.current = null;
  }, []);

  // Stores the open editor's text before it closes or another document
  // replaces it, so no edit waits on a frame that never comes.
  const flushActiveDraft = useCallback(() => {
    cancelPendingSave();
    if (pageOpen) storeDraft(activePath, composeCurrentDocument());
    setSaveState("saved");
  }, [activePath, cancelPendingSave, composeCurrentDocument, pageOpen, storeDraft]);

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
      const target = path === GUESTS_DATASET_PATH ? COLLECTION_TAB : path;
      if (target === activePath && activeTab !== null) return;
      flushActiveDraft();
      showDocument(target);
    },
    [activePath, activeTab, flushActiveDraft, showDocument],
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

  const closeOtherTabs = useCallback(
    (path: string) => {
      openDocument(path);
      setOpenTabs([path]);
    },
    [openDocument],
  );

  const [explorerReveal, setExplorerReveal] = useState<readonly string[] | null>(null);
  const clearExplorerReveal = useCallback(() => setExplorerReveal(null), []);
  const showInExplorer = useCallback((path: string) => {
    setActiveActivity("explorer");
    setSidebarVisible(true);
    setExplorerReveal([path]);
  }, []);

  // The desktop's tab menu draws natively at the pointer. The demo draws it in
  // the page, at the point of the right-click the tab strip just received.
  const tabMenuPoint = useRef({ x: 0, y: 0 });
  const [tabMenu, setTabMenu] = useState<{
    id: number;
    path: string;
    at: { x: number; y: number };
  } | null>(null);
  const tabMenuItems = (path: string): MenuEntry[] => {
    const kind = tabKind(path);
    const filePath = kind === "page" || kind === "app-source" ? path : null;
    const explorerPath = kind === "app" ? APP_ROOT : filePath;
    const item = (id: string, label: string, run: () => void): MenuEntry => ({
      id,
      label,
      testId: `tab-menu-item-${id}`,
      onSelect: run,
    });
    const entries = [item("close-tab", "Close tab", () => closeTab(path))];
    if (openTabs.length > 1) {
      entries.push(item("close-other-tabs", "Close other tabs", () => closeOtherTabs(path)));
    }
    if (explorerPath) entries.push(MENU_SEPARATOR);
    if (filePath) {
      entries.push(
        item("copy-path", "Copy path", () => void navigator.clipboard?.writeText(filePath)),
      );
    }
    if (explorerPath) {
      entries.push(
        item("show-in-explorer", "Show in Explorer", () => showInExplorer(explorerPath)),
      );
    }
    return entries;
  };

  const moveTab = useCallback((path: string, toIndex: number) => {
    setOpenTabs((current) => {
      const next = current.filter((tab) => tab !== path);
      next.splice(toIndex, 0, path);
      return next;
    });
  }, []);

  const openWikilink = useCallback(
    (target: string) => {
      const match = resolveDemoWikilink(
        knownFiles.map((file) => file.path),
        target,
      );
      openDocument(match ?? `${target.trim().replace(/\.md$/i, "")}.md`);
    },
    [knownFiles, openDocument],
  );

  const newPageMarkdown = (title: string) =>
    `---\ntitle: ${title}\nicon: 📝\n---\nStart writing here. Type **/** for commands or **[[** to link another page.\n`;

  const createDocument = useCallback(
    (folder = "") => {
      flushActiveDraft();
      const workspacePaths = new Set(
        collectWorkspacePaths([...Object.keys(draftsRef.current), ...emptyFolders]),
      );
      const prefix = folder ? `${folder}/` : "";
      let index = 1;
      let path = `${prefix}Untitled.md`;
      while (workspacePaths.has(path)) {
        index += 1;
        path = `${prefix}Untitled ${index}.md`;
      }
      storeDraft(path, newPageMarkdown(filenameStem(path)));
      showDocument(path);
    },
    [emptyFolders, flushActiveDraft, showDocument, storeDraft],
  );

  const createDocumentAtPath = useCallback(
    (path: string) => {
      storeDraft(path, newPageMarkdown(filenameStem(path)));
      // Explorer calls onOpenFile immediately after the bridge resolves, before
      // React has published the new documents prop. Select it here so the new
      // file still opens in that same interaction.
      showDocument(path);
    },
    [showDocument, storeDraft],
  );

  const moveDraftPath = useCallback(
    (fromPath: string, toPath: string) => {
      updateDrafts((current) =>
        Object.fromEntries(
          Object.entries(current).map(([path, markdown]) => [
            rewritePathPrefix(path, fromPath, toPath),
            markdown,
          ]),
        ),
      );
      setActivePath((current) => rewritePathPrefix(current, fromPath, toPath));
      setEmptyFolders((current) =>
        current.map((path) => rewritePathPrefix(path, fromPath, toPath)),
      );
      setPinnedPages((current) => current.map((path) => rewritePathPrefix(path, fromPath, toPath)));
    },
    [updateDrafts],
  );

  const deleteDraftPath = useCallback(
    (path: string) => {
      const deleted = (entry: string) => isPathAtOrBelow(entry, path);
      const deletedDrafts = Object.entries(draftsRef.current).filter(([entry]) => deleted(entry));
      const deletedFolders = emptyFolders.filter(deleted);
      const deletedPins = pinnedPages.filter(deleted);
      const next = updateDrafts((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([entry]) => !isPathAtOrBelow(entry, path)),
        ),
      );
      const remainingTabs = openTabs.filter((tab) => !isPathAtOrBelow(tab, path));
      setOpenTabs(remainingTabs);
      if (isPathAtOrBelow(activePath, path)) {
        // The next open tab takes over, as when the tab closes; with none left
        // the editor group is empty.
        const index = Math.max(0, openTabs.indexOf(activePath));
        setActivePath(
          remainingTabs[Math.min(index, remainingTabs.length - 1)] ??
            Object.keys(next)[0] ??
            DEMO_PAGES[0].path,
        );
        setShowSource(false);
        setSourceText("");
      }
      setEmptyFolders((current) =>
        current.filter((entry) => entry !== path && !entry.startsWith(`${path}/`)),
      );
      setPinnedPages((current) => current.filter((entry) => !isPathAtOrBelow(entry, path)));
      return () => {
        updateDrafts((current) => ({ ...current, ...Object.fromEntries(deletedDrafts) }));
        setEmptyFolders((current) => [...new Set([...current, ...deletedFolders])]);
        setPinnedPages((current) => [...new Set([...current, ...deletedPins])]);
      };
    },
    [activePath, emptyFolders, openTabs, pinnedPages, updateDrafts],
  );

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
    if (!showSource && pageOpen) {
      cancelPendingSave();
      const next = composeCurrentDocument();
      storeDraft(activePath, next);
      setSourceText(next);
    }
    setShowSource((current) => !current);
  }, [activePath, cancelPendingSave, composeCurrentDocument, pageOpen, showSource, storeDraft]);

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

  // Where the sidebar covers the editor, what opens from it shows at once.
  const openFromSidebar = useCallback(
    (path: string) => {
      openDocument(path);
      if (sidebarCoversEditor()) setSidebarVisible(false);
    },
    [openDocument],
  );

  const createFromSidebar = useCallback(
    (folder: string) => {
      createDocument(folder);
      if (sidebarCoversEditor()) setSidebarVisible(false);
    },
    [createDocument],
  );

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
      ...(activeTab !== null ? [command("close-tab", () => closeTab(activeTab))] : []),
      ...(pageOpen ? [command("toggle-markdown-source", toggleSource)] : []),
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
    activeTab,
    closeTab,
    createDocument,
    openTabs.length,
    pageOpen,
    showNeighbourTab,
    toggleSidebar,
    toggleSource,
  ]);

  const openSettings = useCallback(
    () =>
      reportShellFailure({
        tone: "warning",
        identity: "demo-settings",
        message: "The demo has no settings. Download dohc to change yours.",
      }),
    [reportShellFailure],
  );

  const createGroupRight = useCallback(
    () =>
      reportShellFailure({
        tone: "warning",
        identity: "demo-editor-group",
        message: "The demo has one editor group. Download dohc to split the editor.",
      }),
    [reportShellFailure],
  );

  // Shell shortcuts work while focus is in the demo. A browser keeps some
  // for itself, such as closing its own tab.
  const runShortcut = useCallback(
    (event: React.KeyboardEvent) => {
      const id = matchShellShortcut(event.nativeEvent, window.dohcDesktop?.platform);
      const run =
        id === "command-palette"
          ? () => setPalette("commands")
          : id === "quick-open"
            ? () => setPalette("quick-open")
            : id === "toggle-sidebar"
              ? toggleSidebar
              : id === "new-file"
                ? createDocument
                : id === "close-tab" && activeTab !== null
                  ? () => closeTab(activeTab)
                  : id === "next-tab"
                    ? () => showNeighbourTab(1)
                    : id === "previous-tab"
                      ? () => showNeighbourTab(-1)
                      : id === "settings"
                        ? openSettings
                        : id === "new-editor-group-right" && activeTab !== null
                          ? createGroupRight
                          : null;
      if (!run) return;
      event.preventDefault();
      if (!deletion) run();
    },
    [
      activeTab,
      closeTab,
      createDocument,
      createGroupRight,
      deletion,
      openSettings,
      showNeighbourTab,
      toggleSidebar,
    ],
  );

  const createFolder = useCallback((path: string) => {
    setEmptyFolders((current) => (current.includes(path) ? current : [...current, path]));
  }, []);

  const togglePinnedPage = useCallback((path: string) => {
    setPinnedPages((current) =>
      current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path],
    );
  }, []);

  const setAppPinned = useCallback((appRoot: string, pinned: boolean) => {
    setPinnedApps((current) =>
      pinned
        ? current.includes(appRoot)
          ? current
          : [...current, appRoot]
        : current.filter((entry) => entry !== appRoot),
    );
  }, []);

  const newCollection = useCallback(
    () =>
      reportShellFailure({
        tone: "warning",
        identity: "demo-new-collection",
        message: "The demo has one Collection. Download dohc to make your own.",
      }),
    [reportShellFailure],
  );

  useLayoutEffect(() => {
    configureDemoDesktopBridge({
      documents,
      folders: emptyFolders,
      fixedPaths: [APP_ENTRY, GUESTS_DATASET_PATH],
      createFile: createDocumentAtPath,
      createFolder,
      movePath: moveDraftPath,
      deletePath: deleteDraftPath,
    });
  }, [createDocumentAtPath, createFolder, deleteDraftPath, documents, emptyFolders, moveDraftPath]);

  const sourceToggle = (labels: { shown: string; hidden: string }) => ({
    label: showSource ? labels.shown : labels.hidden,
    testId: "markdown-edit-toggle",
    onClick: toggleSource,
  });

  let view: React.ReactNode;
  if (activeKind === "page") {
    view = (
      <>
        <ViewActions
          actions={
            <ShellErrorReporter.Provider value={reportShellFailure}>
              <ShellNoticeClear.Provider value={clearIdentity}>
                <DocumentControls
                  toggle={sourceToggle({ shown: "WYSIWYG", hidden: "Source" })}
                  menu={{
                    workspaceId: WORKSPACE_ID,
                    path: activePath,
                    suggestedName: filenameStem(activePath),
                    getMarkdown: () => composeCurrentDocument(),
                  }}
                />
              </ShellNoticeClear.Provider>
            </ShellErrorReporter.Provider>
          }
        />
        {showSource ? (
          <textarea
            className="demo-source"
            value={sourceText}
            readOnly
            spellCheck={false}
            aria-label="Read-only Markdown source"
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
            <PropertiesPanel
              body={activeFullText}
              onChange={updateIdentity}
              onShowSource={toggleSource}
            />
          </div>
          <MarkdownEditor
            key={activePath}
            ref={editorRef}
            value={activeBody}
            onDirty={scheduleSave}
            workspaceId={WORKSPACE_ID}
            path={activePath}
            knownFiles={knownFiles}
            onOpenWikilink={openWikilink}
            resolveWorkspaceAssetUrl={resolveDemoWorkspaceAssetUrl}
            collab={null}
          />
        </div>
      </>
    );
  } else if (activeKind === "app") {
    view = (
      <>
        <ViewActions
          actions={
            <DocumentControls
              toggle={sourceToggle({ shown: "App", hidden: "Source" })}
              menu={null}
            />
          }
        />
        {showSource && (
          <textarea
            className="demo-source"
            value={APP_SOURCE}
            readOnly
            spellCheck={false}
            aria-label={`Read-only source of ${APP_ENTRY}`}
          />
        )}
        <DemoAppFrame theme={theme} hidden={showSource} />
      </>
    );
  } else if (activeKind === "app-source") {
    view = (
      <textarea
        className="demo-source"
        value={APP_SOURCE}
        readOnly
        spellCheck={false}
        aria-label={`Read-only source of ${APP_ENTRY}`}
      />
    );
  } else if (activeKind === "collection") {
    view = (
      <div className="flex min-h-0 flex-1 flex-col">
        <TransactionalCollectionPage
          workspaceId={WORKSPACE_ID}
          dataset={GUESTS_DATASET}
          tableId={GUESTS_TABLE_ID}
          invoke={guests.invoke}
          onError={(fallback, error, retry, identity) =>
            reportShellFailure({
              message: fallback,
              cause: error,
              retry,
              ...(identity !== undefined ? { identity } : {}),
            })
          }
          onSettled={clearIdentity}
          onNotice={(message) => reportShellFailure({ tone: "success", message })}
          confirmDelete={(row) =>
            new Promise((answer) => setDeletion({ recordId: row.id, answer }))
          }
        />
      </div>
    );
  } else {
    view = (
      <EmptyEditorGroup
        platform={window.dohcDesktop?.platform}
        create={{ markdown: createDocument }}
        recent={recentPaths}
        files={documents}
        onOpen={openDocument}
      />
    );
  }

  return (
    <div
      ref={windowRef}
      className="demo-window"
      data-theme={theme}
      data-sidebar-visible={sidebarVisible}
      tabIndex={-1}
      onKeyDown={runShortcut}
    >
      <Titlebar
        workspace={DEMO_WORKSPACE}
        workspaces={[DEMO_WORKSPACE]}
        onSwitchWorkspace={() => undefined}
        onQuickOpen={() => setPalette("quick-open")}
        version={<DemoVersion />}
        workspaceStatus={<WorkspaceSyncStatus syncStatus={DEMO_SYNC_STATUS} failedSaves={0} />}
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
          onOpenSettings={openSettings}
          notices={
            <NoticeCenter
              workspaceId={WORKSPACE_ID}
              syncStatus={null}
              agentActive={false}
              conflictSummaries={[]}
              onOpenHistory={() => selectActivity("history")}
              onOpenSettings={openSettings}
              onOpenConflicts={() => undefined}
              onRefreshShareView={() => undefined}
              onRebuildEngineStore={() => undefined}
              workspaceErrors={shellErrors.map((error) => ({
                ...error,
                copy: { report: error.message },
                canRetry: error.retry !== null,
                ...(error.action ? { actionLabel: error.action.label } : {}),
              }))}
              onRetryWorkspaceError={retryShellError}
              onWorkspaceErrorAction={runShellErrorAction}
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
          activePath={activeTab}
          openTabs={openTabs}
          tabLabels={TAB_LABELS}
          pinnedPages={pinnedPages}
          pinnedApps={pinnedApps}
          onTogglePinnedPage={togglePinnedPage}
          onSetAppPinned={setAppPinned}
          onNewCollection={newCollection}
          onOpenDocument={openFromSidebar}
          onCloseTab={closeTab}
          onCloseAllTabs={closeAllTabs}
          onOpenTabsChange={setOpenTabs}
          onCreateDocument={createFromSidebar}
          onBeforeChanges={async () => flushActiveDraft()}
          onError={reportFailureMessage}
          onNotice={showSuccessNotice}
          revealPaths={explorerReveal}
          onRevealed={clearExplorerReveal}
        />

        <main
          className="flex min-w-0 flex-1 flex-col bg-bg"
          onContextMenuCapture={(event) => {
            tabMenuPoint.current = { x: event.clientX, y: event.clientY };
          }}
        >
          <EditorGroupFrame
            tabs={(actionsRef) => (
              <EditorTabs
                actionsRef={actionsRef}
                groupId={DEMO_EDITOR_GROUP_ID}
                groupNumber={1}
                tabs={openTabs.map((path) => ({ path }))}
                activeTab={activeTab}
                activeTabDirty={pageOpen && saveState === "saving"}
                files={fileEntries}
                tabLabels={TAB_LABELS}
                recoveryPaths={NO_PATHS}
                onActivate={(_groupId, path) => openDocument(path)}
                onClose={(_groupId, path) => closeTab(path)}
                onContextMenu={(_groupId, path) =>
                  setTabMenu((current) => ({
                    id: (current?.id ?? 0) + 1,
                    path,
                    at: tabMenuPoint.current,
                  }))
                }
                onMove={(_groupId, path, toIndex) => moveTab(path, toIndex)}
                onMoveToGroup={() => undefined}
                onCreateGroupRight={createGroupRight}
              />
            )}
          >
            {view}
          </EditorGroupFrame>
          {tabMenu ? (
            <Menu
              key={tabMenu.id}
              label={TAB_LABELS.get(tabMenu.path) ?? filename(tabMenu.path)}
              at={tabMenu.at}
              open
              onOpenChange={(open) => {
                if (!open) setTabMenu(null);
              }}
              items={tabMenuItems(tabMenu.path)}
              menuTestId="tab-menu"
            />
          ) : null}
        </main>
      </div>
      {deletion ? (
        <div className="demo-overlay">
          <DeleteCollectionRecordDialog
            collectionName={GUESTS_DATASET.name}
            recordId={deletion.recordId}
            onCancel={() => {
              deletion.answer(false);
              setDeletion(null);
            }}
            onConfirm={() => {
              deletion.answer(true);
              setDeletion(null);
            }}
          />
        </div>
      ) : null}
      {palette ? (
        <div className="demo-overlay">
          {palette === "quick-open" ? (
            <QuickOpenPalette
              files={workspaceFiles}
              recent={recentPaths}
              pinned={pinnedPages}
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

export function ProductDemo() {
  return (
    <WorkspaceSessionProvider workspaceId={WORKSPACE_ID}>
      <ProductDemoWindow />
    </WorkspaceSessionProvider>
  );
}
