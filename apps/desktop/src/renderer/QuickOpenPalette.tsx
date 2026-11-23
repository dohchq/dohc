import { Clock, Pin } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import type { WorkspaceFileEntry } from "../ipc/bridgeContract";
import { CommandPalette, MAX_COMMAND_PALETTE_MATCHES, type Command } from "./CommandPalette";
import { basenameOf, dirnameOf } from "./path";
import { FileGlyph, listedFileKind } from "./ui/KindGlyph";
import { fileTone } from "./workbench/EmptyEditorGroup";
import { prepareQuickOpenPaths, rankPreparedQuickOpenPaths } from "./workbench/quick-open-rank";

export type QuickOpenFile = {
  path: string;
  kind?: WorkspaceFileEntry["kind"];
  icon?: string | undefined;
};

export function QuickOpenPalette(props: {
  files: readonly QuickOpenFile[];
  recent: readonly string[];
  pinned: readonly string[];
  onOpenPath: (path: string) => void;
  onClose: () => void;
}) {
  const onOpenPath = useRef(props.onOpenPath);
  onOpenPath.current = props.onOpenPath;

  const commands = useMemo<Command[]>(() => {
    const pinnedSet = new Set(props.pinned);
    const recentSet = new Set(props.recent);
    const hasSections = pinnedSet.size > 0 || recentSet.size > 0;
    return props.files.map((file) => {
      const kind = listedFileKind(file.path, file.kind);
      const isPinned = pinnedSet.has(file.path);
      const isRecent = !isPinned && recentSet.has(file.path);
      const folder = dirnameOf(file.path);
      return {
        id: file.path,
        label: basenameOf(file.path),
        subtitle: folder || undefined,
        ariaLabel: file.path,
        icon: <FileGlyph kind={kind} icon={file.icon} size={14} className={fileTone(kind)} />,
        badge: isPinned ? (
          <Pin size={12} aria-hidden />
        ) : isRecent ? (
          <Clock size={12} aria-hidden />
        ) : undefined,
        group: isPinned ? "Pinned" : isRecent ? "Recent" : hasSections ? "Files" : undefined,
        run: () => onOpenPath.current(file.path),
      };
    });
  }, [props.files, props.pinned, props.recent]);
  const ranking = useMemo(() => {
    const commandsByPath = new Map(commands.map((command) => [command.id, command]));
    return {
      commandsByPath,
      paths: prepareQuickOpenPaths([...commandsByPath.keys()], {
        recent: props.recent,
        pinned: props.pinned,
      }),
    };
  }, [commands, props.pinned, props.recent]);
  const rank = useCallback(
    (query: string) =>
      rankPreparedQuickOpenPaths(query, ranking.paths, MAX_COMMAND_PALETTE_MATCHES).map((path) =>
        ranking.commandsByPath.get(path)!,
      ),
    [ranking],
  );

  return (
    <CommandPalette
      testId="quick-open"
      toggleShortcut="quick-open"
      placeholder="Go to…"
      ariaLabel="File"
      commands={commands}
      rank={rank}
      emptyText={quickOpenEmptyText}
      acceptLabel="Open"
      onClose={props.onClose}
    />
  );
}

function quickOpenEmptyText(query: string): string {
  return query ? `No files match "${query}". Try a shorter search.` : "No files yet.";
}
