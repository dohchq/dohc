import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { Overlay } from "./Overlay";

export function NewFileDialog(props: {
  workspaceId: string;
  onClose: () => void;
  onCreated: (path: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function create() {
    if (!name.trim()) return;
    try {
      const result = await bridge().createWorkspaceFile({
        workspaceId: props.workspaceId,
        relativePath: name.trim(),
      });
      props.onCreated(result.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <Overlay onClose={props.onClose}>
      <div className="w-105 max-w-[80vw] rounded-lg border border-line bg-panel p-3 shadow-lg">
        <input
          ref={inputRef}
          type="text"
          aria-label="File name"
          placeholder="notes/today.md"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") props.onClose();
            if (event.key === "Enter") void create();
          }}
          className="w-full rounded border border-line bg-bg px-3 py-2 font-mono text-[13px] text-ink outline-none placeholder:text-subtle"
        />
        {error ? <p className="mb-0 mt-2 text-xs text-danger">{error}</p> : null}
      </div>
    </Overlay>
  );
}
