import { useEffect, useRef, useState } from "react";
import { Overlay } from "./Overlay";

export interface Command {
  id: string;
  label: string;
  run: () => void;
}

export function CommandPalette(props: {
  commands: Command[];
  onClose: () => void;
  testId?: string;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Cap rendered rows: a workspace can have thousands of files (quick-open),
  // and rendering them all per keystroke is wasted work.
  const MAX_MATCHES = 50;
  const matches = props.commands
    .filter((command) =>
      command.label.toLowerCase().includes(query.toLowerCase()),
    )
    .slice(0, MAX_MATCHES);

  function runCommand(command: Command | undefined) {
    if (!command) return;
    props.onClose();
    command.run();
  }

  return (
    <Overlay onClose={props.onClose}>
      <div
        data-testid={props.testId ?? "command-palette"}
        className="w-130 max-w-[80vw] overflow-hidden rounded-lg border border-line bg-panel shadow-lg"
      >
        <input
          ref={inputRef}
          type="text"
          aria-label={props.ariaLabel ?? "Command"}
          placeholder={props.placeholder ?? "Type a command…"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") props.onClose();
            if (event.key === "Enter") runCommand(matches[0]);
          }}
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-ink outline-none placeholder:text-subtle"
        />
        <ul role="listbox" aria-label="Commands" className="m-0 max-h-72 list-none overflow-y-auto p-1">
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-xs text-subtle">No matching commands</li>
          ) : (
            matches.map((command, index) => (
              <li key={command.id} role="option" aria-selected={index === 0}>
                <button
                  type="button"
                  onClick={() => runCommand(command)}
                  className={`w-full rounded px-3 py-1.5 text-left text-[13px] ${
                    index === 0 ? "bg-panel-2 text-ink" : "text-muted hover:text-ink"
                  }`}
                >
                  {command.label}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </Overlay>
  );
}
