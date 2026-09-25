import { useCallback, useMemo, useRef } from "react";
import {
  CommandPalette,
  MAX_COMMAND_PALETTE_MATCHES,
  type Command,
} from "./CommandPalette";
import {
  prepareQuickOpenPaths,
  rankPreparedQuickOpenPaths,
} from "./workbench/quick-open-rank";

export function QuickOpenPalette(props: {
  files: readonly { path: string }[];
  recent: readonly string[];
  pinned: readonly string[];
  onOpenPath: (path: string) => void;
  onClose: () => void;
}) {
  const onOpenPath = useRef(props.onOpenPath);
  onOpenPath.current = props.onOpenPath;

  const commands = useMemo<Command[]>(
    () =>
      props.files.map((file) => ({
        id: file.path,
        label: file.path,
        run: () => onOpenPath.current(file.path),
      })),
    [props.files],
  );
  const ranking = useMemo(() => {
    // Match the previous Map behavior if a listing contains duplicate paths.
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
      rankPreparedQuickOpenPaths(
        query,
        ranking.paths,
        MAX_COMMAND_PALETTE_MATCHES,
      ).map((path) => ranking.commandsByPath.get(path)!),
    [ranking],
  );

  return (
    <CommandPalette
      testId="quick-open"
      placeholder="Go to…"
      ariaLabel="File"
      commands={commands}
      rank={rank}
      onClose={props.onClose}
    />
  );
}
