import { DohcMark } from "@dohc/brand";
import {
  Bell,
  ChevronDown,
  Cloud,
  FileClock,
  FileText,
  GitBranch,
  MessagesSquare,
  MoreHorizontal,
  Search,
  Settings,
  Share2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "../../desktop/src/renderer/editor/MarkdownEditor";
import { PageIdentity } from "../../desktop/src/renderer/PageIdentity";
import {
  applyFrontmatter,
  parseFrontmatter,
} from "../../desktop/src/renderer/markdown/frontmatter";
import {
  DEMO_ACTIVITY_ITEMS,
  DemoSidebar,
  type DemoPanelId,
  type DemoWorkspaceDocument,
} from "./DemoSidebar";

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

const HISTORY_ITEMS = [
  {
    title: "Edited welcome.md",
    meta: "Local file edit · just now",
    path: "welcome.md",
  },
  {
    title: "Saved latest edits",
    meta: "Workspace moment · 2 minutes ago",
    path: "projects/launch-plan.md",
  },
  {
    title: "Created launch-plan.md",
    meta: "Local file edit · today",
    path: "projects/launch-plan.md",
  },
  {
    title: "Updated agent workflows",
    meta: "Agent edit · today",
    path: "research/agent-workflows.md",
  },
  {
    title: "Reconciled offline edits",
    meta: "Workspace history · yesterday",
    path: "welcome.md",
  },
] as const;

const LINKED_CHAT_ITEMS = [
  {
    title: "Launch planning",
    meta: "2 messages · launch-plan.md",
    path: "projects/launch-plan.md",
  },
  {
    title: "Agent workflow review",
    meta: "1 message · agent-workflows.md",
    path: "research/agent-workflows.md",
  },
] as const;

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
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [showSource, setShowSource] = useState(false);
  const [sourceText, setSourceText] = useState("");
  const [density, setDensity] = useState<"comfortable" | "compact">(
    "comfortable",
  );
  const [cloudConnected, setCloudConnected] = useState(false);
  const [rightRailView, setRightRailView] = useState<"history" | "chats">(
    "history",
  );
  const [rightRailQuery, setRightRailQuery] = useState("");
  const editorRef = useRef<MarkdownEditorHandle>(null);
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
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

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
    setDrafts((current) => {
      const next = { ...current, [path]: markdown };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // The in-memory editor still works when persistence is unavailable.
      }
      return next;
    });
  }, []);

  const scheduleSave = useCallback(() => {
    setSaveState("saving");
    requestAnimationFrame(() => {
      storeDraft(activePath, composeCurrentDocument());
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

  const rightRailItems = useMemo(() => {
    const source = rightRailView === "history" ? HISTORY_ITEMS : LINKED_CHAT_ITEMS;
    const query = rightRailQuery.trim().toLowerCase();
    if (!query) return source;
    return source.filter((item) =>
      `${item.title} ${item.meta}`.toLowerCase().includes(query),
    );
  }, [rightRailQuery, rightRailView]);

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

  return (
    <div
      className="demo-window"
      data-theme={theme}
      data-density={density}
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
        <nav className="demo-activity" aria-label="Demo activity bar">
          {DEMO_ACTIVITY_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`demo-rail-button${
                sidebarVisible && activeActivity === item.id ? " is-active" : ""
              }`}
              type="button"
              title={item.label}
              aria-label={item.label}
              aria-current={
                sidebarVisible && activeActivity === item.id ? "page" : undefined
              }
              onClick={() => selectActivity(item.id)}
            >
              <item.icon size={18} strokeWidth={1.9} aria-hidden />
            </button>
          ))}
          <div className="demo-activity-bottom">
            <button
              className={`demo-rail-button${
                sidebarVisible && activeActivity === "cloud" ? " is-active" : ""
              }`}
              type="button"
              title="dohc Cloud"
              aria-label="dohc Cloud"
              aria-current={
                sidebarVisible && activeActivity === "cloud" ? "page" : undefined
              }
              onClick={() => selectActivity("cloud")}
            >
              <Cloud size={18} strokeWidth={1.9} aria-hidden />
            </button>
            <button
              className={`demo-rail-button${
                sidebarVisible && activeActivity === "settings"
                  ? " is-active"
                  : ""
              }`}
              type="button"
              title="Open settings"
              aria-label="Open settings"
              aria-current={
                sidebarVisible && activeActivity === "settings" ? "page" : undefined
              }
              onClick={() => selectActivity("settings")}
            >
              <Settings size={18} strokeWidth={1.9} aria-hidden />
            </button>
          </div>
        </nav>

        <DemoSidebar
          activePanel={activeActivity}
          visible={sidebarVisible}
          documents={documents}
          activePath={activePath}
          theme={theme}
          density={density}
          cloudConnected={cloudConnected}
          onOpenDocument={openDocument}
          onCreateDocument={createDocument}
          onSetTheme={setTheme}
          onSetDensity={setDensity}
          onToggleCloud={() => setCloudConnected((current) => !current)}
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
            <span className="demo-doc-kind">{showSource ? "markdown source" : "document"}</span>
            <Share2 size={13} aria-hidden />
            <span className="demo-save-state">{saveState === "saved" ? "Saved" : "Saving..."}</span>
            <button className="demo-header-button" type="button" onClick={toggleSource}>
              {showSource ? "Editor" : "Source"}
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

        <aside className="demo-history">
          <div className="demo-history-tabs">
            <button
              className={`demo-history-tab${rightRailView === "history" ? " is-active" : ""}`}
              type="button"
              onClick={() => setRightRailView("history")}
            >
              History
            </button>
            <button
              className={`demo-history-tab${rightRailView === "chats" ? " is-active" : ""}`}
              type="button"
              onClick={() => setRightRailView("chats")}
            >
              Chats
            </button>
          </div>
          <label className="demo-history-search">
            <Search size={12} aria-hidden />
            <input
              value={rightRailQuery}
              onChange={(event) => setRightRailQuery(event.target.value)}
              placeholder={rightRailView === "history" ? "Search history" : "Search chats"}
              aria-label={rightRailView === "history" ? "Search history" : "Search chats"}
            />
          </label>
          <div className="demo-history-list">
            <div className="demo-history-date">
              {rightRailView === "history" ? "Today" : "Linked to workspace"}
            </div>
            {rightRailItems.map((item) => (
              <button
                className="demo-history-item"
                key={item.title}
                type="button"
                onClick={() => openDocument(item.path)}
              >
                {rightRailView === "history" ? (
                  <FileClock size={13} aria-hidden />
                ) : (
                  <MessagesSquare size={13} aria-hidden />
                )}
                <div>
                  <div className="demo-history-title">{item.title}</div>
                  <div className="demo-history-meta">{item.meta}</div>
                </div>
              </button>
            ))}
          </div>
        </aside>
      </div>

      <footer className="demo-statusbar">
        <span>personal</span>
        <span className="demo-status-local">Local · {saveState}</span>
        <span className="demo-status-right">
          <Bell size={12} aria-hidden />
          <Cloud size={12} aria-hidden />
          {cloudConnected ? "Cloud connected" : "Connect dohc Cloud"}
          <GitBranch size={12} aria-hidden /> Main
          <Settings size={12} aria-hidden /> Settings
        </span>
      </footer>
    </div>
  );
}
