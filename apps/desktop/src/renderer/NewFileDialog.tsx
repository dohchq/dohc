import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { Overlay } from "./Overlay";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { withMarkdownDefault } from "./workbench/new-file-name";

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

  function close() {
    if (pendingRef.current) return;
    props.onClose();
  }

  async function create() {
    const relativePath = withMarkdownDefault(name.trim());
    if (!relativePath || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await bridge().createWorkspaceFile({
        workspaceId: props.workspaceId,
        relativePath,
        initialText: "",
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
    <Overlay
      onClose={close}
      panelProps={{
        role: "dialog",
        "aria-modal": true,
        "aria-labelledby": "new-file-title",
        "aria-describedby": "new-file-help",
      }}
    >
      <form
        className="dohc-elevated flex w-105 max-w-[80vw] flex-col gap-2.5 rounded-xl border border-line bg-panel p-5"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div className="flex flex-col gap-1">
          <h2 id="new-file-title" className="m-0 text-sm font-semibold text-ink">
            New file
          </h2>
          <p id="new-file-help" className="m-0 text-xs text-muted">
            Name it like a path — any folders you name are created for you.
            No extension means markdown (.md).
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
          className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[13px] text-ink placeholder:text-subtle disabled:opacity-50"
        />
        {error ? (
          <p role="alert" className="m-0 text-xs text-danger">
            {error}
          </p>
        ) : null}
        <div className="mt-1 flex justify-end gap-2">
          <SecondaryButton onClick={close} disabled={pending}>
            Cancel
          </SecondaryButton>
          <PrimaryButton type="submit" disabled={!name.trim() || pending}>
            {pending ? "Creating…" : "Create file"}
          </PrimaryButton>
        </div>
      </form>
    </Overlay>
  );
}
