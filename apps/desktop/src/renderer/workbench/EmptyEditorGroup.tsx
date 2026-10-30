import { useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { FILE_KIND_RECORDS, type FileKindRecord } from "@dohc/workspace-contracts/kinds";
import type { WorkspaceFileEntry } from "../../ipc/bridgeContract";
import { shortcutAccelerators, shortcutText } from "../../shortcuts/shortcutRegistry";
import { EmptyState } from "../ui/controls";
import { FileGlyph, KindGlyph, listedFileKind, ObjectGlyph } from "../ui/KindGlyph";
import { fileName } from "./EditorTabs";
import { START_TILE_ART, type StartKind } from "./StartTileArt";

// A kind's create action. One that returns a promise holds every tile until
// it settles.
type CreateAction = () => void | Promise<unknown>;
type ListedFile = { path: string; kind?: WorkspaceFileEntry["kind"]; icon?: string | undefined };

// Each kind keeps one hue. styles.css has no kind hues yet, so these borrow
// the identity hues.
const KIND_TONE: Record<StartKind, string> = {
  markdown: "text-ink",
  collection: "text-hue-teal",
  drawing: "text-hue-plum",
  app: "text-hue-amber",
};

// What a person can make, in tile order. A drawing takes its name from the
// kind registry. A Markdown file is a Page, as the Explorer's Home calls it.
// The registry names no Collection or App, so those labels live only here.
const START_KINDS: readonly { kind: StartKind; label: string; glyph: ReactNode; shortcut?: "new-file" }[] = [
  { kind: "markdown", label: "Page", shortcut: "new-file", glyph: <KindGlyph kind={FILE_KIND_RECORDS.markdown} size={16} className={KIND_TONE.markdown} /> },
  { kind: "collection", label: "Collection", glyph: <ObjectGlyph kind="collection" size={16} className={KIND_TONE.collection} /> },
  { kind: "drawing", label: FILE_KIND_RECORDS.drawing.name, glyph: <KindGlyph kind={FILE_KIND_RECORDS.drawing} size={16} className={KIND_TONE.drawing} /> },
  { kind: "app", label: "App", glyph: <ObjectGlyph kind="app" size={16} className={KIND_TONE.app} /> },
];

const RECENT_LIMIT = 5;

// The recent paths that are still listed files, most recent first.
function recentFiles(recent: readonly string[], files: readonly ListedFile[]): ListedFile[] {
  if (recent.length === 0) return [];
  const wanted = new Set(recent);
  const listed = new Map<string, ListedFile>();
  for (const file of files) {
    if (wanted.has(file.path)) listed.set(file.path, file);
    if (listed.size === wanted.size) break;
  }
  return recent.flatMap((path) => listed.get(path) ?? []).slice(0, RECENT_LIMIT);
}

function fileTone(kind: FileKindRecord): string | undefined {
  return kind.displayKind === "markdown" || kind.displayKind === "drawing" ? KIND_TONE[kind.displayKind] : undefined;
}

// The chord as aria-keyshortcuts spells it: Meta+N on macOS, Control+N elsewhere.
function ariaShortcut(id: "new-file", platform: string | undefined): string | undefined {
  return shortcutAccelerators(id, platform)[0]?.split("+")
    .map((key) => key === "CommandOrControl" ? (platform === "darwin" ? "Meta" : "Control") : key === "Ctrl" ? "Control" : key)
    .join("+");
}

// An editor group with no open tab shows what a person can make, and their
// recent work under it.
export function EmptyEditorGroup(props: {
  platform: string | undefined;
  // The create action of each kind the workspace offers. A kind without one
  // has no tile.
  create: Partial<Record<StartKind, CreateAction>>;
  // Opened paths, most recent first.
  recent: readonly string[];
  // The workspace's files, or null until its first listing lands.
  files: readonly ListedFile[] | null;
  onOpen: (path: string) => void;
  // Adds dropped files. Absent where the workspace takes no import.
  onDropFiles?: (files: File[]) => void;
}) {
  const recentId = useId();
  // A press while an action runs does nothing, so a double click makes one app.
  const running = useRef(false);
  const recent = useMemo(() => props.files ? recentFiles(props.recent, props.files) : [], [props.recent, props.files]);
  const tiles = START_KINDS.flatMap((tile) => {
    const create = props.create[tile.kind];
    return create ? [{ ...tile, create }] : [];
  });
  const onDropFiles = props.files?.length === 0 ? props.onDropFiles : undefined;

  if (tiles.length === 0 && recent.length === 0 && !onDropFiles) {
    return <EmptyState data-testid="start-surface" title="Select a file" />;
  }

  function run(create: CreateAction) {
    if (running.current) return;
    const pending = create();
    if (!(pending instanceof Promise)) return;
    running.current = true;
    const release = () => { running.current = false; };
    void pending.then(release, release);
  }

  return (
    <div data-testid="start-surface" className="@container flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* The cards sit at a share of the group's height, so what lands later
          grows below them and never moves them. */}
      <div aria-hidden className="max-h-64 min-h-8 shrink-0 basis-[22%]" />
      <div className="mx-auto flex w-full max-w-176 flex-col gap-8 px-8 pb-8">
        {tiles.length > 0 ? (
          <div className="grid grid-cols-2 gap-4 @lg:grid-cols-4">
            {tiles.map((tile) => (
              <button
                key={tile.kind}
                type="button"
                aria-keyshortcuts={tile.shortcut ? ariaShortcut(tile.shortcut, props.platform) : undefined}
                onClick={() => run(tile.create)}
                className="group flex min-w-0 flex-col gap-2 rounded-lg text-left focus-visible:outline-offset-4"
              >
                <span aria-hidden className="relative block h-28 overflow-hidden rounded-lg border border-line bg-panel transition-colors duration-100 group-hover:border-ink/30 group-hover:bg-panel-2">
                  {START_TILE_ART[tile.kind]}
                </span>
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
                  {tile.glyph}
                  <span className="truncate">{tile.label}</span>
                  {/* The chord shows only where it leaves the name whole. */}
                  {tile.shortcut ? (
                    <span aria-hidden className="ml-auto hidden shrink-0 text-[12px] font-normal text-subtle @2xl:block">
                      {shortcutText(tile.shortcut, props.platform)}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {onDropFiles ? <DropZone onDrop={onDropFiles} /> : null}
        {recent.length > 0 ? (
          <section aria-labelledby={recentId}>
            <h2 id={recentId} className="pb-2 text-[12px] font-medium text-subtle">Recent</h2>
            {/* A row's text starts on the cards' edge and its hover fill hangs outside it. */}
            <ul className="-mx-2">
              {recent.map((file) => {
                const kind = listedFileKind(file.path, file.kind);
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      title={file.path.includes("/") ? file.path : undefined}
                      onClick={() => props.onOpen(file.path)}
                      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted transition-colors duration-75 hover:bg-hover hover:text-ink"
                    >
                      <FileGlyph kind={kind} icon={file.icon} size={16} className={fileTone(kind)} />
                      <span className="min-w-0 truncate">{fileName(file.path)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

// Files dropped here land at the workspace root, as on the Explorer's empty space.
function DropZone(props: { onDrop: (files: File[]) => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      data-testid="start-drop"
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        const files = [...event.dataTransfer.files];
        if (files.length > 0) props.onDrop(files);
      }}
      className={`flex h-11 items-center justify-center gap-2 rounded-lg border border-dashed text-[13px] transition-colors duration-100 ${over ? "border-accent bg-hover text-ink" : "border-line text-subtle"}`}
    >
      <Upload size={16} aria-hidden />
      Drop files here to add them
    </div>
  );
}
