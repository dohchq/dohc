import {
  Bot,
  CaseSensitive,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  ExternalLink,
  FileClock,
  FilePlus2,
  Files,
  FileText,
  Folder,
  Globe2,
  History,
  MessagesSquare,
  MoreHorizontal,
  RefreshCw,
  Search,
  Send,
  Settings,
  Workflow,
  X,
} from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";

export type DemoPanelId =
  | "explorer"
  | "search"
  | "chats"
  | "graph"
  | "sites"
  | "history"
  | "cloud"
  | "settings";

export type DemoWorkspaceDocument = {
  path: string;
  title: string;
  body: string;
};

export const DEMO_ACTIVITY_ITEMS = [
  { id: "explorer", label: "Explorer", icon: Files },
  { id: "search", label: "Search", icon: Search },
  { id: "chats", label: "Chats", icon: MessagesSquare },
  { id: "graph", label: "Graph", icon: Workflow },
  { id: "sites", label: "Sites", icon: Globe2 },
  { id: "history", label: "History", icon: History },
] as const;

type ChatThreadId = "launch" | "research";

type DemoChatMessage = {
  id: string;
  author: string;
  body: string;
  kind: "agent" | "human";
  time: string;
};

const CHAT_THREADS: Array<{
  id: ChatThreadId;
  label: string;
  path: string;
  description: string;
}> = [
  {
    id: "launch",
    label: "launch-planning",
    path: "projects/launch-plan.md",
    description: "Prepare the first public release",
  },
  {
    id: "research",
    label: "agent-workflows",
    path: "research/agent-workflows.md",
    description: "Turn repeated work into skills",
  },
];

const INITIAL_CHAT_MESSAGES: Record<ChatThreadId, DemoChatMessage[]> = {
  launch: [
    {
      id: "launch-1",
      author: "You",
      body: "What still needs a decision before launch?",
      kind: "human",
      time: "9:41",
    },
    {
      id: "launch-2",
      author: "dohc agent",
      body:
        "The launch plan has two open tasks. I would decide the first-user workspace before publishing the story.",
      kind: "agent",
      time: "9:42",
    },
  ],
  research: [
    {
      id: "research-1",
      author: "dohc agent",
      body:
        "I grouped the workflow into capture, review, and reuse. The source document is linked here.",
      kind: "agent",
      time: "Yesterday",
    },
  ],
};

const HISTORY_ITEMS = [
  {
    title: "Edited welcome.md",
    meta: "Local file edit, just now",
    path: "welcome.md",
  },
  {
    title: "Saved launch decisions",
    meta: "Workspace moment, 2 minutes ago",
    path: "projects/launch-plan.md",
  },
  {
    title: "Created launch-plan.md",
    meta: "Local file edit, today",
    path: "projects/launch-plan.md",
  },
  {
    title: "Updated agent workflows",
    meta: "Agent edit, today",
    path: "research/agent-workflows.md",
  },
  {
    title: "Reconciled offline edits",
    meta: "Workspace history, yesterday",
    path: "welcome.md",
  },
] as const;

const DEMO_SITES = [
  {
    id: "personal-hq",
    name: "Personal HQ",
    status: "Published",
    domain: "personal.dohc.site",
    description: "A clear home for notes, plans, and current work.",
    path: "welcome.md",
  },
  {
    id: "launch-room",
    name: "Launch room",
    status: "Draft",
    domain: "launch-preview.dohc.site",
    description: "A private launch brief generated from the workspace.",
    path: "projects/launch-plan.md",
  },
] as const;

const GRAPH_LAYOUTS = [
  [
    { x: 50, y: 23 },
    { x: 27, y: 69 },
    { x: 74, y: 68 },
  ],
  [
    { x: 25, y: 32 },
    { x: 72, y: 28 },
    { x: 50, y: 76 },
  ],
] as const;

function basename(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function dirname(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "";
}

function PanelHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="demo-panel-header">
      <span>{title}</span>
      {children ? <span className="demo-panel-actions">{children}</span> : null}
    </header>
  );
}

function ExplorerPanel({
  documents,
  activePath,
  onOpenDocument,
  onCreateDocument,
}: {
  documents: DemoWorkspaceDocument[];
  activePath: string;
  onOpenDocument: (path: string) => void;
  onCreateDocument: () => void;
}) {
  const [foldersOpen, setFoldersOpen] = useState(true);
  const rootDocuments = documents.filter((document) => !dirname(document.path));
  const folderNames = Array.from(
    new Set(documents.map((document) => dirname(document.path)).filter(Boolean)),
  );

  return (
    <>
      <PanelHeader title="Explorer">
        <button
          className="demo-icon-button"
          type="button"
          aria-label="New file"
          title="New file"
          onClick={onCreateDocument}
        >
          <FilePlus2 size={14} aria-hidden />
        </button>
        <button
          className="demo-icon-button"
          type="button"
          aria-label={foldersOpen ? "Collapse folders" : "Expand folders"}
          title={foldersOpen ? "Collapse folders" : "Expand folders"}
          onClick={() => setFoldersOpen((current) => !current)}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
        <button
          className="demo-icon-button"
          type="button"
          aria-label="More actions"
          title="More actions"
          onClick={() => setFoldersOpen(true)}
        >
          <MoreHorizontal size={14} aria-hidden />
        </button>
      </PanelHeader>
      <div className="demo-tree">
        <div className="demo-tree-label">
          <ChevronDown size={12} aria-hidden /> Open editors
        </div>
        <div className="demo-tree-files">
          {documents.slice(0, 4).map((document) => (
            <DocumentRow
              key={`open-${document.path}`}
              document={document}
              active={activePath === document.path}
              onOpen={onOpenDocument}
            />
          ))}
        </div>
        <button
          className="demo-tree-label demo-tree-label-button"
          type="button"
          aria-expanded={foldersOpen}
          onClick={() => setFoldersOpen((current) => !current)}
        >
          {foldersOpen ? (
            <ChevronDown size={12} aria-hidden />
          ) : (
            <ChevronRight size={12} aria-hidden />
          )}
          Files
        </button>
        {foldersOpen ? (
          <>
            {rootDocuments.map((document) => (
              <DocumentRow
                key={`root-${document.path}`}
                document={document}
                active={activePath === document.path}
                onOpen={onOpenDocument}
              />
            ))}
            {folderNames.map((folder) => (
              <div key={folder}>
                <div className="demo-file demo-folder-row">
                  <Folder size={13} aria-hidden />
                  <span>{folder}</span>
                </div>
                {documents
                  .filter((document) => dirname(document.path) === folder)
                  .map((document) => (
                    <DocumentRow
                      key={`tree-${document.path}`}
                      document={document}
                      active={activePath === document.path}
                      onOpen={onOpenDocument}
                      nested
                    />
                  ))}
              </div>
            ))}
          </>
        ) : null}
      </div>
    </>
  );
}

function DocumentRow({
  document,
  active,
  onOpen,
  nested = false,
}: {
  document: DemoWorkspaceDocument;
  active: boolean;
  onOpen: (path: string) => void;
  nested?: boolean;
}) {
  return (
    <button
      className={`demo-file${active ? " is-active" : ""}${nested ? " is-nested" : ""}`}
      type="button"
      title={document.path}
      onClick={() => onOpen(document.path)}
    >
      <FileText size={13} aria-hidden />
      <span>{basename(document.path)}</span>
    </button>
  );
}

function SearchPanel({
  documents,
  onOpenDocument,
}: {
  documents: DemoWorkspaceDocument[];
  onOpenDocument: (path: string) => void;
}) {
  const [query, setQuery] = useState("workspace");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const results = useMemo(() => {
    const needle = caseSensitive ? query.trim() : query.trim().toLowerCase();
    if (!needle) return [];
    return documents.flatMap((document) => {
      const lines = document.body.split("\n");
      const title = caseSensitive ? document.title : document.title.toLowerCase();
      const titleMatch = title.includes(needle)
        ? [{ line: 1, preview: document.title }]
        : [];
      const bodyMatches = lines.flatMap((line, index) => {
        const haystack = caseSensitive ? line : line.toLowerCase();
        return haystack.includes(needle) && line.trim()
          ? [{ line: index + 1, preview: line.trim() }]
          : [];
      });
      return [...titleMatch, ...bodyMatches].slice(0, 3).map((match) => ({
        ...match,
        path: document.path,
      }));
    });
  }, [caseSensitive, documents, query]);

  return (
    <>
      <PanelHeader title="Search">
        <button
          className={`demo-icon-button${caseSensitive ? " is-pressed" : ""}`}
          type="button"
          aria-label="Match case"
          aria-pressed={caseSensitive}
          title="Match case"
          onClick={() => setCaseSensitive((current) => !current)}
        >
          <CaseSensitive size={14} aria-hidden />
        </button>
      </PanelHeader>
      <div className="demo-panel-body">
        <label className="demo-field">
          <span className="demo-field-label">Search workspace</span>
          <span className="demo-search-input-wrap">
            <Search size={13} aria-hidden />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search text and titles"
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                <X size={12} aria-hidden />
              </button>
            ) : null}
          </span>
        </label>
        <div className="demo-results-summary">
          {query ? `${results.length} matches` : "Type to search all documents"}
        </div>
        <div className="demo-search-results" aria-live="polite">
          {results.map((result, index) => (
            <button
              key={`${result.path}-${result.line}-${index}`}
              className="demo-search-result"
              type="button"
              onClick={() => onOpenDocument(result.path)}
            >
              <span className="demo-search-result-file">
                <FileText size={12} aria-hidden />
                {basename(result.path)}
                <span>{result.line}</span>
              </span>
              <span className="demo-search-result-preview">{result.preview}</span>
            </button>
          ))}
          {query && !results.length ? (
            <div className="demo-panel-empty">
              <Search size={18} aria-hidden />
              <strong>No matches</strong>
              <span>Try another word from your workspace.</span>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}

function ChatsPanel({ onOpenDocument }: { onOpenDocument: (path: string) => void }) {
  const [selectedThread, setSelectedThread] = useState<ChatThreadId>("launch");
  const [messages, setMessages] = useState(INITIAL_CHAT_MESSAGES);
  const [draft, setDraft] = useState("");
  const thread = CHAT_THREADS.find((item) => item.id === selectedThread)!;

  function sendMessage(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setMessages((current) => ({
      ...current,
      [selectedThread]: [
        ...current[selectedThread],
        {
          id: `${selectedThread}-${Date.now()}`,
          author: "You",
          body,
          kind: "human",
          time: "Now",
        },
      ],
    }));
    setDraft("");
  }

  return (
    <>
      <PanelHeader title="Chats">
        <button
          className="demo-icon-button"
          type="button"
          aria-label="Open linked file"
          title="Open linked file"
          onClick={() => onOpenDocument(thread.path)}
        >
          <FileText size={13} aria-hidden />
        </button>
      </PanelHeader>
      <div className="demo-chat-panel">
        <div className="demo-chat-threads" aria-label="Chat channels">
          {CHAT_THREADS.map((item) => (
            <button
              key={item.id}
              className={item.id === selectedThread ? "is-active" : ""}
              type="button"
              onClick={() => setSelectedThread(item.id)}
            >
              <MessagesSquare size={12} aria-hidden />
              <span>
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          ))}
        </div>
        <div className="demo-chat-heading">
          <span>#{thread.label}</span>
          <button type="button" onClick={() => onOpenDocument(thread.path)}>
            {basename(thread.path)} <ExternalLink size={11} aria-hidden />
          </button>
        </div>
        <div className="demo-chat-messages" aria-live="polite">
          {messages[selectedThread].map((message) => (
            <article className="demo-chat-message" key={message.id}>
              <span className={`demo-chat-avatar is-${message.kind}`}>
                {message.kind === "agent" ? (
                  <Bot size={12} aria-hidden />
                ) : (
                  message.author.slice(0, 1)
                )}
              </span>
              <div>
                <header>
                  <strong>{message.author}</strong>
                  <time>{message.time}</time>
                </header>
                <p>{message.body}</p>
              </div>
            </article>
          ))}
        </div>
        <form className="demo-chat-composer" onSubmit={sendMessage}>
          <label htmlFor="demo-chat-message">Message #{thread.label}</label>
          <span>
            <input
              id="demo-chat-message"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Write a message"
            />
            <button type="submit" aria-label="Send message" disabled={!draft.trim()}>
              <Send size={13} aria-hidden />
            </button>
          </span>
        </form>
      </div>
    </>
  );
}

function GraphPanel({
  documents,
  activePath,
  onOpenDocument,
}: {
  documents: DemoWorkspaceDocument[];
  activePath: string;
  onOpenDocument: (path: string) => void;
}) {
  const [layoutIndex, setLayoutIndex] = useState(0);
  const visibleDocuments = documents.slice(0, 3);
  const points = GRAPH_LAYOUTS[layoutIndex];

  return (
    <>
      <PanelHeader title="Graph">
        <button
          className="demo-icon-button"
          type="button"
          aria-label="Refresh graph layout"
          title="Refresh graph layout"
          onClick={() => setLayoutIndex((current) => (current + 1) % GRAPH_LAYOUTS.length)}
        >
          <RefreshCw size={13} aria-hidden />
        </button>
      </PanelHeader>
      <div className="demo-panel-body">
        <p className="demo-panel-copy">
          Linked notes stay navigable. Select a node to open its source.
        </p>
        <div className="demo-graph" aria-label="Workspace link graph">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            {points.slice(1).map((point, index) => (
              <line
                key={`${point.x}-${point.y}`}
                x1={points[0].x}
                y1={points[0].y}
                x2={point.x}
                y2={point.y}
              />
            ))}
            <line
              x1={points[1].x}
              y1={points[1].y}
              x2={points[2].x}
              y2={points[2].y}
            />
          </svg>
          {visibleDocuments.map((document, index) => (
            <button
              key={document.path}
              className={`demo-graph-node${document.path === activePath ? " is-active" : ""}`}
              style={{ left: `${points[index].x}%`, top: `${points[index].y}%` }}
              type="button"
              title={`Open ${document.title}`}
              onClick={() => onOpenDocument(document.path)}
            >
              <FileText size={13} aria-hidden />
              <span>{document.title}</span>
            </button>
          ))}
        </div>
        <div className="demo-graph-legend">
          <span>{visibleDocuments.length} documents</span>
          <span>3 links</span>
        </div>
      </div>
    </>
  );
}

function SitesPanel({ onOpenDocument }: { onOpenDocument: (path: string) => void }) {
  const [selectedSite, setSelectedSite] = useState<(typeof DEMO_SITES)[number]["id"]>(
    DEMO_SITES[0].id,
  );
  const site = DEMO_SITES.find((item) => item.id === selectedSite)!;

  return (
    <>
      <PanelHeader title="Sites">
        <button
          className="demo-icon-button"
          type="button"
          aria-label="New site"
          title="New site"
          onClick={() => setSelectedSite("launch-room")}
        >
          <Globe2 size={13} aria-hidden />
        </button>
      </PanelHeader>
      <div className="demo-panel-body">
        <p className="demo-panel-copy">
          Publish workspace documents as simple, source-backed sites.
        </p>
        <div className="demo-site-list">
          {DEMO_SITES.map((item) => (
            <button
              key={item.id}
              className={item.id === selectedSite ? "is-active" : ""}
              type="button"
              onClick={() => setSelectedSite(item.id)}
            >
              <Globe2 size={14} aria-hidden />
              <span>
                <strong>{item.name}</strong>
                <small>{item.domain}</small>
              </span>
              <em>{item.status}</em>
            </button>
          ))}
        </div>
        <section className="demo-site-detail" aria-label={`${site.name} details`}>
          <header>
            <span>{site.status}</span>
            <strong>{site.name}</strong>
          </header>
          <p>{site.description}</p>
          <dl>
            <div>
              <dt>Source</dt>
              <dd>{basename(site.path)}</dd>
            </div>
            <div>
              <dt>Domain</dt>
              <dd>{site.domain}</dd>
            </div>
          </dl>
          <button type="button" onClick={() => onOpenDocument(site.path)}>
            Open source <ExternalLink size={12} aria-hidden />
          </button>
        </section>
      </div>
    </>
  );
}

function HistoryPanel({ onOpenDocument }: { onOpenDocument: (path: string) => void }) {
  const [query, setQuery] = useState("");
  const items = HISTORY_ITEMS.filter((item) =>
    `${item.title} ${item.meta}`.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <>
      <PanelHeader title="History" />
      <div className="demo-panel-body">
        <label className="demo-field">
          <span className="demo-field-label">Filter history</span>
          <span className="demo-search-input-wrap">
            <Search size={13} aria-hidden />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter edits and moments"
            />
          </span>
        </label>
        <div className="demo-history-panel-list">
          <div className="demo-history-date">Today</div>
          {items.map((item) => (
            <button key={item.title} type="button" onClick={() => onOpenDocument(item.path)}>
              <FileClock size={13} aria-hidden />
              <span>
                <strong>{item.title}</strong>
                <small>{item.meta}</small>
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function CloudPanel({
  connected,
  onToggle,
}: {
  connected: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <PanelHeader title="dohc Cloud" />
      <div className="demo-panel-body demo-cloud-panel">
        <Cloud size={30} strokeWidth={1.5} aria-hidden />
        <strong>{connected ? "Connected for collaboration" : "Local by default"}</strong>
        <p>
          {connected
            ? "Live collaboration is enabled for this demo workspace."
            : "Connect only when you want live collaboration. Your files remain local."}
        </p>
        <button type="button" onClick={onToggle}>
          {connected ? (
            <>
              <Check size={13} aria-hidden /> Connected
            </>
          ) : (
            "Connect cloud"
          )}
        </button>
      </div>
    </>
  );
}

function SettingsPanel({
  theme,
  density,
  onSetTheme,
  onSetDensity,
}: {
  theme: "light" | "dark";
  density: "comfortable" | "compact";
  onSetTheme: (theme: "light" | "dark") => void;
  onSetDensity: (density: "comfortable" | "compact") => void;
}) {
  return (
    <>
      <PanelHeader title="Settings" />
      <div className="demo-panel-body demo-settings-panel">
        <fieldset>
          <legend>Appearance</legend>
          <div className="demo-segmented-control">
            {(["light", "dark"] as const).map((option) => (
              <button
                key={option}
                className={theme === option ? "is-active" : ""}
                type="button"
                aria-pressed={theme === option}
                onClick={() => onSetTheme(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Sidebar density</legend>
          <div className="demo-segmented-control">
            {(["comfortable", "compact"] as const).map((option) => (
              <button
                key={option}
                className={density === option ? "is-active" : ""}
                type="button"
                aria-pressed={density === option}
                onClick={() => onSetDensity(option)}
              >
                {option}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="demo-setting-row">
          <span>
            <strong>Autosave</strong>
            <small>Save local edits as you type</small>
          </span>
          <span className="demo-setting-value">On</span>
        </div>
        <div className="demo-setting-row">
          <span>
            <strong>Workspace</strong>
            <small>Personal, local first</small>
          </span>
          <span className="demo-setting-value">Local</span>
        </div>
      </div>
    </>
  );
}

export function DemoSidebar({
  activePanel,
  visible,
  documents,
  activePath,
  theme,
  density,
  cloudConnected,
  onOpenDocument,
  onCreateDocument,
  onSetTheme,
  onSetDensity,
  onToggleCloud,
}: {
  activePanel: DemoPanelId;
  visible: boolean;
  documents: DemoWorkspaceDocument[];
  activePath: string;
  theme: "light" | "dark";
  density: "comfortable" | "compact";
  cloudConnected: boolean;
  onOpenDocument: (path: string) => void;
  onCreateDocument: () => void;
  onSetTheme: (theme: "light" | "dark") => void;
  onSetDensity: (density: "comfortable" | "compact") => void;
  onToggleCloud: () => void;
}) {
  return (
    <aside
      className={`demo-sidebar${visible ? "" : " is-collapsed"}`}
      aria-label={`${activePanel} panel`}
      aria-hidden={!visible}
    >
      {activePanel === "explorer" ? (
        <ExplorerPanel
          documents={documents}
          activePath={activePath}
          onOpenDocument={onOpenDocument}
          onCreateDocument={onCreateDocument}
        />
      ) : activePanel === "search" ? (
        <SearchPanel documents={documents} onOpenDocument={onOpenDocument} />
      ) : activePanel === "chats" ? (
        <ChatsPanel onOpenDocument={onOpenDocument} />
      ) : activePanel === "graph" ? (
        <GraphPanel
          documents={documents}
          activePath={activePath}
          onOpenDocument={onOpenDocument}
        />
      ) : activePanel === "sites" ? (
        <SitesPanel onOpenDocument={onOpenDocument} />
      ) : activePanel === "history" ? (
        <HistoryPanel onOpenDocument={onOpenDocument} />
      ) : activePanel === "cloud" ? (
        <CloudPanel connected={cloudConnected} onToggle={onToggleCloud} />
      ) : (
        <SettingsPanel
          theme={theme}
          density={density}
          onSetTheme={onSetTheme}
          onSetDensity={onSetDensity}
        />
      )}
    </aside>
  );
}
