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
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function create() {
    const relativePath = name.trim();
    if (!relativePath || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await bridge().createWorkspaceFile({
        workspaceId: props.workspaceId,
        relativePath,
      });
      props.onCreated(result.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <Overlay onClose={props.onClose}>
      <div className="dohc-elevated flex w-105 max-w-[80vw] flex-col gap-2.5 rounded-xl border border-line bg-panel p-5">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-sm font-semibold text-ink">New file</h2>
          <p className="m-0 text-xs text-muted">
            Name it like a path — any folders you name are created for you.
          </p>
        </div>
        <input
          spellCheck={false}
          ref={inputRef}
          type="text"
          aria-label="File name"
          placeholder="notes/today.md"
          disabled={pending}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") props.onClose();
            if (event.key === "Enter") void create();
          }}
          className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[13px] text-ink outline-none placeholder:text-subtle focus:border-ink disabled:opacity-50"
        />
        {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}
      </div>
    </Overlay>
  );
}
