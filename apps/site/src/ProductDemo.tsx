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
import { configureDemoDesktopBridge } from "./demoDesktopBridge";

type DemoDocument = {
  path: string;
  markdown: string;
};

type SaveState = "saved" | "saving";

const STORAGE_KEY = "dohc-marketing-demo-documents-v2";

const DEMO_DOCUMENTS: DemoDocument[] = [
  {
    path: "welcome.md",
    markdown: `---
title: Your workspace, in plain sight
icon: 📝
---
This is the same WYSIWYG editor that ships in the desktop app. Click anywhere and make it yours.

## Try the editor

- Select text to format it
- Type **/** on an empty line for commands
- Use **[[** to link another document
- Write Markdown shortcuts and watch them become blocks

> [!note] Text is the primitive
> Everything stays readable by you and your agents.

- [x] A real document surface
- [ ] Your next idea
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
| Local first | The workspace belongs to the user |
| Text based | Humans and agents can inspect the same truth |
| Individual first | One person should feel the magic immediately |

The plan can change. The history stays visible.
`,
  },
  {
    path: "research/agent-workflows.md",
    markdown: `---
title: Agent workflows
icon: 🧠
---
## A repeatable loop

1. Capture the intent
2. Let the agent shape the workspace
3. Review the proposed changes
4. Keep the useful process as a skill

### The contract

Agents get familiar tools. Users keep explicit ownership, permissions, and review gates.

\`\`\`text
intent -> inspectable work -> review -> durable context
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
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    for (const [path, markdown] of Object.entries(parsed)) {
      if (
        typeof markdown === "string" &&
        path.endsWith(".md") &&
        !path.split("/").includes("..")
      ) {
        defaults[path] = markdown;
      }
    }
  } catch {
    // A blocked or malformed localStorage entry should never stop the demo.
  }
  return defaults;
}

function persistDrafts(drafts: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    // The in-memory editor still works when persistence is unavailable.
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
  const [activePath, setActivePath] = useState(DEMO_DOCUMENTS[0].path);
  const [activeActivity, setActiveActivity] =
    useState<DemoPanelId>("explorer");
  const [sidebarVisible, setSidebarVisible] = useState(initialSidebarVisible);
  const [drafts, setDrafts] = useState<Record<string, string>>(initialDrafts);
  const [emptyFolders, setEmptyFolders] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [showSource, setShowSource] = useState(false);
  const [sourceText, setSourceText] = useState("");
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const saveFrame = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);

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

  useEffect(
    () => () => {
      if (saveFrame.current !== null) cancelAnimationFrame(saveFrame.current);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  useEffect(() => {
    persistDrafts(drafts);
  }, [drafts]);

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
    setDrafts((current) => ({ ...current, [path]: markdown }));
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
      storeDraft(activePath, composeCurrentDocument());
      setShowSource(false);
      setActivePath(path);
      setSaveState("saved");
    },
    [activePath, composeCurrentDocument, storeDraft],
  );

  const createDocument = useCallback(() => {
    storeDraft(activePath, composeCurrentDocument());
    let index = 1;
    let path = "notes/quick-note.md";
    while (drafts[path]) {
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
  }, [activePath, composeCurrentDocument, drafts, storeDraft]);

  const createDocumentAtPath = useCallback(
    (path: string) => {
      const title = filenameStem(path)
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
      storeDraft(
        path,
        `---\ntitle: ${title}\nicon: 📝\n---\nStart writing here. Type **/** for commands or **[[** to link another page.\n`,
      );
    },
    [storeDraft],
  );

  const moveDraftPath = useCallback((fromPath: string, toPath: string) => {
    setDrafts((current) => {
      const next = { ...current };
      for (const [path, markdown] of Object.entries(current)) {
        if (path !== fromPath && !path.startsWith(`${fromPath}/`)) continue;
        const suffix = path.slice(fromPath.length);
        delete next[path];
        next[`${toPath}${suffix}`] = markdown;
      }
      return next;
    });
    setActivePath((current) =>
      current === fromPath || current.startsWith(`${fromPath}/`)
        ? `${toPath}${current.slice(fromPath.length)}`
        : current,
    );
    setEmptyFolders((current) =>
      current.map((path) =>
        path === fromPath || path.startsWith(`${fromPath}/`)
          ? `${toPath}${path.slice(fromPath.length)}`
          : path,
      ),
    );
  }, []);

  const deleteDraftPath = useCallback((path: string) => {
    const next = Object.fromEntries(
      Object.entries(drafts).filter(
        ([entry]) => entry !== path && !entry.startsWith(`${path}/`),
      ),
    );
    if (Object.keys(next).length === 0) {
      const fallback = DEMO_DOCUMENTS[0];
      next[fallback.path] = fallback.markdown;
    }
    setDrafts(next);
    setActivePath((current) =>
      current === path || current.startsWith(`${path}/`)
        ? (Object.keys(next)[0] ?? DEMO_DOCUMENTS[0].path)
        : current,
    );
    setEmptyFolders((current) =>
      current.filter((entry) => entry !== path && !entry.startsWith(`${path}/`)),
    );
  }, [drafts]);

  const updateIdentity = useCallback(
    (nextFullText: string) => {
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
    [activeBody, activePath, storeDraft],
  );

  const toggleSource = useCallback(() => {
    if (!showSource) {
      const next = composeCurrentDocument();
      storeDraft(activePath, next);
      setSourceText(next);
    }
    setShowSource((current) => !current);
  }, [activePath, composeCurrentDocument, showSource, storeDraft]);

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
      createFile: createDocumentAtPath,
      createFolder,
      movePath: moveDraftPath,
      deletePath: deleteDraftPath,
    });
  }, [createDocumentAtPath, createFolder, deleteDraftPath, documents, moveDraftPath]);

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
        <ActivityBar
          activeView={activeActivity}
          sidebarVisible={sidebarVisible}
          hasConflict={false}
          chatsEnabled
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
              onOpenWikilink={openDocument}
              collab={null}
            />
          </div>
        </section>
      </div>

      <footer className="demo-statusbar">
        <span>personal</span>
        <span className="demo-status-local">Local · {saveState}</span>
        <span className="demo-status-right">
          <Bell size={12} aria-hidden />
          <Cloud size={12} aria-hidden />
          Connect dohc Cloud
          <GitBranch size={12} aria-hidden /> Main
          <Settings size={12} aria-hidden /> Settings
        </span>
      </footer>
    </div>
  );
}
