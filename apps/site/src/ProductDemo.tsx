import { DohcMark } from "@dohc/brand";
import {
  Bell,
  ChevronDown,
  Cloud,
  FileClock,
  FilePlus2,
  Files,
  FileText,
  Folder,
  GitBranch,
  Globe2,
  History,
  MessagesSquare,
  MoreHorizontal,
  RefreshCw,
  Search,
  Settings,
  Share2,
  Workflow,
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

const ACTIVITY_ITEMS = [
  { id: "explorer", label: "Explorer", icon: Files },
  { id: "search", label: "Search", icon: Search },
  { id: "chats", label: "Chats", icon: MessagesSquare },
  { id: "graph", label: "Graph", icon: Workflow },
  { id: "sites", label: "Sites", icon: Globe2 },
  { id: "history", label: "History", icon: History },
] as const;

const HISTORY_ITEMS = [
  ["Edited welcome.md", "Local file edit · just now"],
  ["Saved latest edits", "Workspace moment · 2 minutes ago"],
  ["Created launch-plan.md", "Local file edit · today"],
  ["Updated agent workflows", "Agent edit · today"],
  ["Reconciled offline edits", "Workspace history · yesterday"],
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
    for (const document of DEMO_DOCUMENTS) {
      if (typeof parsed[document.path] === "string") {
        defaults[document.path] = parsed[document.path] as string;
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

export function ProductDemo() {
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);
  const [activePath, setActivePath] = useState(DEMO_DOCUMENTS[0].path);
  const [activeActivity, setActiveActivity] = useState("explorer");
  const [drafts, setDrafts] = useState<Record<string, string>>(initialDrafts);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [showSource, setShowSource] = useState(false);
  const [sourceText, setSourceText] = useState("");
  const editorRef = useRef<MarkdownEditorHandle>(null);
  const saveTimer = useRef<number | null>(null);

  const activeFullText = drafts[activePath] ?? "";
  const activeBody = parseFrontmatter(activeFullText).body;
  const knownFiles = useMemo(
    () =>
      DEMO_DOCUMENTS.map((document) => ({
        path: document.path,
        title: String(
          parseFrontmatter(drafts[document.path] ?? document.markdown).meta.title ??
            filenameStem(document.path),
        ),
      })),
    [drafts],
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

  return (
    <div className="demo-window" data-theme={theme}>
      <header className="demo-titlebar">
        <span className="demo-brand">
          <DohcMark size={14} />
          <span>dohc</span>
        </span>
        <button className="demo-workspace" type="button">
          personal <ChevronDown size={12} aria-hidden />
        </button>
        <button className="demo-command" type="button">
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
          {ACTIVITY_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`demo-rail-button${activeActivity === item.id ? " is-active" : ""}`}
              type="button"
              title={item.label}
              aria-label={item.label}
              onClick={() => setActiveActivity(item.id)}
            >
              <item.icon size={18} strokeWidth={1.9} aria-hidden />
            </button>
          ))}
          <div className="demo-activity-bottom">
            <button className="demo-rail-button" type="button" title="dohc Cloud" aria-label="dohc Cloud">
              <Cloud size={18} strokeWidth={1.9} aria-hidden />
            </button>
            <button className="demo-rail-button" type="button" title="Open settings" aria-label="Open settings">
              <Settings size={18} strokeWidth={1.9} aria-hidden />
            </button>
          </div>
        </nav>

        <aside className="demo-sidebar">
          <header className="demo-panel-header">
            Explorer
            <span className="demo-panel-actions">
              <button className="demo-icon-button" type="button" aria-label="New file" title="New file">
                <FilePlus2 size={14} aria-hidden />
              </button>
              <button className="demo-icon-button" type="button" aria-label="Refresh" title="Refresh">
                <RefreshCw size={13} aria-hidden />
              </button>
              <button className="demo-icon-button" type="button" aria-label="More actions" title="More actions">
                <MoreHorizontal size={14} aria-hidden />
              </button>
            </span>
          </header>
          <div className="demo-tree">
            <div className="demo-tree-label">
              <ChevronDown size={12} aria-hidden /> Open editors
            </div>
            <div className="demo-tree-files">
              {DEMO_DOCUMENTS.map((document) => (
                <button
                  key={`open-${document.path}`}
                  className={`demo-file${activePath === document.path ? " is-active" : ""}`}
                  type="button"
                  onClick={() => openDocument(document.path)}
                >
                  <FileText size={13} aria-hidden />
                  <span>{filename(document.path)}</span>
                </button>
              ))}
            </div>
            <div className="demo-tree-label" style={{ marginTop: 10 }}>
              <ChevronDown size={12} aria-hidden /> Files
            </div>
            <div className="demo-file" aria-hidden>
              <Folder size={13} /> <span>projects</span>
            </div>
            <div className="demo-file" aria-hidden>
              <Folder size={13} /> <span>research</span>
            </div>
            <div className="demo-tree-files">
              {DEMO_DOCUMENTS.map((document) => (
                <button
                  key={`tree-${document.path}`}
                  className={`demo-file${activePath === document.path ? " is-active" : ""}`}
                  type="button"
                  onClick={() => openDocument(document.path)}
                >
                  <FileText size={13} aria-hidden />
                  <span>{filename(document.path)}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

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
            <button className="demo-history-tab is-active" type="button">History</button>
            <button className="demo-history-tab" type="button">Chats</button>
          </div>
          <div className="demo-history-search">
            <Search size={12} aria-hidden /> Search history
          </div>
          <div className="demo-history-list">
            <div className="demo-history-date">Today</div>
            {HISTORY_ITEMS.map(([title, meta]) => (
              <div className="demo-history-item" key={title}>
                <FileClock size={13} aria-hidden />
                <div>
                  <div className="demo-history-title">{title}</div>
                  <div className="demo-history-meta">{meta}</div>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      <footer className="demo-statusbar">
        <span>personal</span>
        <span className="demo-status-local">Local · {saveState}</span>
        <span className="demo-status-right">
          <Bell size={12} aria-hidden />
          <Cloud size={12} aria-hidden /> Connect dohc Cloud
          <GitBranch size={12} aria-hidden /> Main
          <Settings size={12} aria-hidden /> Settings
        </span>
      </footer>
    </div>
  );
}
