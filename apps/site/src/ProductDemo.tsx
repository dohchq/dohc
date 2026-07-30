import { DohcMark } from "@dohc/brand";
import {
  Bell,
  ChevronDown,
  Cloud,
  FileText,
  GitBranch,
  MoreHorizontal,
  Search,
  Settings,
  Share2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "../../desktop/src/renderer/editor/MarkdownEditor";
import { PageIdentity } from "../../desktop/src/renderer/PageIdentity";
import {
  applyFrontmatter,
  parseFrontmatter,
} from "../../desktop/src/renderer/markdown/frontmatter";
import { ActivityBar } from "../../desktop/src/renderer/workbench/ActivityBar";
import {
  DemoSidebar,
  type DemoPanelId,
  type DemoWorkspaceDocument,
} from "./DemoSidebar";
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

const STORAGE_KEY = "dohc-marketing-demo-documents";
const FOLDERS_STORAGE_KEY = "dohc-marketing-demo-folders-v1";

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

export function ProductDemo() {
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);
  const [drafts, setDrafts] = useState<Record<string, string>>(initialDrafts);
  const [activePath, setActivePath] = useState(
    () => Object.keys(drafts)[0] ?? DEMO_DOCUMENTS[0].path,
  );
  const [activeActivity, setActiveActivity] =
    useState<DemoPanelId>("explorer");
  const [sidebarVisible, setSidebarVisible] = useState(initialSidebarVisible);
  const [emptyFolders, setEmptyFolders] = useState<string[]>(initialFolders);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [showSource, setShowSource] = useState(false);
  const [sourceText, setSourceText] = useState("");
  const [assetsPersistAcrossSessions, setAssetsPersistAcrossSessions] =
    useState(demoWorkspaceAssetsPersistAcrossSessions);
  const [workspacePersistsAcrossSessions, setWorkspacePersistsAcrossSessions] =
    useState(localStorageIsAvailable);
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const saveFrame = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const draftsRef = useRef(drafts);

  const updateDrafts = useCallback(
    (update: (current: Record<string, string>) => Record<string, string>) => {
      const next = update(draftsRef.current);
      draftsRef.current = next;
      setDrafts(next);
      return next;
    },
    [],
  );

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

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const markSessionOnly = () => setAssetsPersistAcrossSessions(false);
    window.addEventListener(DEMO_ASSET_PERSISTENCE_EVENT, markSessionOnly);
    return () =>
      window.removeEventListener(DEMO_ASSET_PERSISTENCE_EVENT, markSessionOnly);
  }, []);

  useEffect(
    () => () => {
      if (saveFrame.current !== null) cancelAnimationFrame(saveFrame.current);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!persistDrafts(drafts)) setWorkspacePersistsAcrossSessions(false);
  }, [drafts]);

  useEffect(() => {
    if (!persistFolders(emptyFolders)) setWorkspacePersistsAcrossSessions(false);
  }, [emptyFolders]);

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

  const openDocument = useCallback(
    (path: string) => {
      if (path === activePath) return;
      cancelPendingSave();
      storeDraft(activePath, composeCurrentDocument());
      setShowSource(false);
      setActivePath(path);
      setSaveState("saved");
    },
    [activePath, cancelPendingSave, composeCurrentDocument, storeDraft],
  );

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

  const flushActiveDraft = useCallback(async () => {
    cancelPendingSave();
    storeDraft(activePath, composeCurrentDocument());
    setSaveState("saved");
  }, [activePath, cancelPendingSave, composeCurrentDocument, storeDraft]);

  const createDocument = useCallback(() => {
    cancelPendingSave();
    storeDraft(activePath, composeCurrentDocument());
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
    setShowSource(false);
    setActivePath(path);
    setSaveState("saved");
  }, [activePath, cancelPendingSave, composeCurrentDocument, emptyFolders, storeDraft]);

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
      setShowSource(false);
      setActivePath(path);
      setSaveState("saved");
    },
    [storeDraft],
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
    if (isPathAtOrBelow(activePath, path)) {
      setActivePath(Object.keys(next)[0] ?? DEMO_DOCUMENTS[0].path);
      setShowSource(false);
      setSourceText("");
    }
    setEmptyFolders((current) =>
      current.filter((entry) => entry !== path && !entry.startsWith(`${path}/`)),
    );
  }, [activePath, updateDrafts]);

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
    >
      <header className="demo-titlebar">
        <span className="demo-brand">
          <DohcMark size={14} />
          <span>dohc</span>
        </span>
        <button className="demo-workspace" type="button">
          personal <ChevronDown size={12} aria-hidden />
        </button>
        <button
          className="demo-command"
          type="button"
          onClick={() => selectActivity("search")}
        >
          <Search size={12} aria-hidden />
          <span>Search files...</span>
          <kbd>Ctrl P</kbd>
        </button>
        <span className="demo-window-controls" aria-hidden>
          <span className="demo-window-control" />
          <span className="demo-window-control" />
          <span className="demo-window-control" />
        </span>
      </header>

      <div className="demo-workbench">
        {/* The demo's chats panel is currently UNREACHABLE: this prop was the
            only thing that could select it, and ActivityBar stopped accepting
            a chats prop in eb2c578b when chats became the app's right-side
            panel. React silently drops unknown props, so the toggle has been
            dead ever since -- only the typecheck noticed. Restoring the
            affordance means giving the demo a real right-side panel like
            Titlebar's titlebar-chats-sidebar control, which is UI work in its
            own right, not a drive-by on a typecheck fix. */}
        <ActivityBar
          activeView={activeActivity === "chats" ? "explorer" : activeActivity}
          sidebarVisible={sidebarVisible}
          hasConflict={false}
          onSelectView={selectActivity}
        />

        <DemoSidebar
          activePanel={activeActivity}
          visible={sidebarVisible}
          documents={documents}
          folders={emptyFolders}
          activePath={activePath}
          onOpenDocument={openDocument}
          onCreateDocument={createDocument}
          onBeforeChanges={flushActiveDraft}
        />

        <section className="demo-editor-column" aria-label="Editable dohc document demo">
          <div className="demo-tabs">
            <div className="demo-tab">
              <FileText size={13} aria-hidden />
              <span className="demo-tab-name">{filename(activePath)}</span>
              <button className="demo-tab-close" type="button" aria-label={`Close ${filename(activePath)}`}>
                <X size={12} aria-hidden />
              </button>
            </div>
            <div className="demo-tabs-fill" />
            <button className="demo-icon-button" type="button" aria-label="All open tabs" title="All open tabs">
              <ChevronDown size={13} aria-hidden />
            </button>
          </div>
          <div className="demo-editor-header">
            <FileText size={13} aria-hidden />
            <span className="demo-doc-name">{filename(activePath)}</span>
            <span className="demo-doc-kind">document</span>
            <Share2 size={13} aria-hidden />
            <button
              className={`demo-header-button${showSource ? "" : " is-active"}`}
              type="button"
              onClick={() => showSource && toggleSource()}
            >
              Styled
            </button>
            <button
              className={`demo-header-button${showSource ? " is-active" : ""}`}
              type="button"
              onClick={() => !showSource && toggleSource()}
            >
              Source
            </button>
            <button className="demo-icon-button" type="button" aria-label="Document menu" title="Document menu">
              <MoreHorizontal size={14} aria-hidden />
            </button>
          </div>
          {showSource ? (
            <textarea className="demo-source" value={sourceText} readOnly spellCheck={false} aria-label="Read-only markdown source" />
          ) : null}
          <div
            className="demo-editor-pane"
            data-dohc-doc-pane=""
            hidden={showSource}
          >
            <div className="dohc-page-topmatter">
              <PageIdentity
                body={activeFullText}
                onChange={updateIdentity}
                filenameStem={filenameStem(activePath)}
                onEnterBody={() => editorRef.current?.focus("start")}
              />
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
        </section>
      </div>

      <footer className="demo-statusbar">
        <span>personal</span>
        <span
          className="demo-status-local"
          title={
            !workspacePersistsAcrossSessions
              ? "Workspace changes will remain available for this browser session only."
              : !assetsPersistAcrossSessions
                ? "Image assets will remain available for this browser session only."
                : undefined
          }
        >
          Local / {saveState}
          {!workspacePersistsAcrossSessions
            ? " / workspace session-only"
            : !assetsPersistAcrossSessions
              ? " / assets session-only"
              : ""}
        </span>
        <span className="demo-status-right">
          <Bell size={12} aria-hidden />
          <Cloud size={12} aria-hidden />
          Connect sync
          <GitBranch size={12} aria-hidden /> Main
          <Settings size={12} aria-hidden /> Settings
        </span>
      </footer>
    </div>
  );
}
