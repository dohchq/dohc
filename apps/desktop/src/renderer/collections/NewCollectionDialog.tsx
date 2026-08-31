import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  COLLECTION_SCHEMA_FILENAME,
  type CollectionSchema,
} from "@dohc/workspace-contracts";
import { bridge } from "../bridge";
import { Overlay } from "../Overlay";
import { IconButton, PrimaryButton, SecondaryButton, SectionLabel } from "../ui/controls";
import {
  draftToField,
  emptyFieldDraft,
  fieldDraftError,
  FieldDraftRow,
  type FieldDraft,
} from "./FieldForm";
import { serializeCollectionSchema } from "./schemaAuthoring";

// The New collection flow (docs/plans/collections.md Phase 2, settled
// 2026-08-31): a folder becomes a collection only through this dialog's name
// plus first fields, or an agent writing the schema file directly. The
// dialog speaks in collections, fields, and types; the file underneath stays
// inspectable but is never on screen.

export function NewCollectionDialog(props: {
  workspaceId: string;
  /** A folder to create the collection inside, from the Explorer menu. */
  initialFolder?: string;
  onClose: () => void;
  /** Receives the new collection's folder path. */
  onCreated: (collectionPath: string) => void;
}) {
  const [name, setName] = useState(
    props.initialFolder ? `${props.initialFolder}/` : "",
  );
  const [drafts, setDrafts] = useState<FieldDraft[]>([emptyFieldDraft("Name")]);
  const [relationTargets, setRelationTargets] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Relation fields target existing collections. Best-effort: without the
  // list a relation draft simply has nothing to choose.
  const { workspaceId } = props;
  useEffect(() => {
    let stale = false;
    void bridge()
      .listCollections({ workspaceId })
      .then((result) => {
        if (stale) return;
        setRelationTargets(result.collections.map((entry) => entry.path));
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [workspaceId]);

  async function create() {
    const folder = name.trim().replace(/\/+$/, "");
    if (!folder || pendingRef.current) return;
    const fieldNames: string[] = [];
    for (const draft of drafts) {
      const problem = fieldDraftError(draft, fieldNames);
      if (problem !== null) {
        setError(problem);
        return;
      }
      fieldNames.push(draft.name.trim());
    }
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const schema: CollectionSchema = {
      name: folder.split("/").at(-1) ?? folder,
      description: null,
      fields: drafts.map(draftToField),
      views: [],
    };
    try {
      const result = await bridge().createWorkspaceFile({
        workspaceId: props.workspaceId,
        relativePath: `${folder}/${COLLECTION_SCHEMA_FILENAME}`,
        initialText: serializeCollectionSchema(schema),
      });
      props.onCreated(
        result.path.slice(0, -(COLLECTION_SCHEMA_FILENAME.length + 1)),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <Overlay onClose={props.onClose}>
      <div
        data-testid="new-collection-dialog"
        className="dohc-elevated flex w-130 max-w-[85vw] flex-col gap-3 rounded-xl border border-line bg-panel p-5"
      >
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-sm font-semibold text-ink">New collection</h2>
          <p className="m-0 text-xs text-muted">
            A collection holds records that share fields. Name it like a path
            — any folders you name are created for you.
          </p>
        </div>
        <input
          spellCheck={false}
          ref={inputRef}
          type="text"
          aria-label="Collection name"
          placeholder="projects/tasks"
          disabled={pending}
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") props.onClose();
            if (event.key === "Enter") void create();
          }}
          className="w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[13px] text-ink placeholder:text-subtle focus:border-ink disabled:opacity-50"
        />
        <div className="flex flex-col gap-2">
          <SectionLabel>Fields</SectionLabel>
          {drafts.map((draft, index) => (
            <div key={index} className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1">
                <FieldDraftRow
                  draft={draft}
                  disabled={pending}
                  relationTargets={relationTargets}
                  onChange={(next) =>
                    setDrafts((current) =>
                      current.map((entry, at) => (at === index ? next : entry)),
                    )
                  }
                />
              </div>
              <IconButton
                aria-label="Remove field"
                disabled={pending || drafts.length === 1}
                onClick={() =>
                  setDrafts((current) => current.filter((_, at) => at !== index))
                }
              >
                <X size={14} strokeWidth={1.9} />
              </IconButton>
            </div>
          ))}
          <SecondaryButton
            className="self-start"
            disabled={pending}
            onClick={() => setDrafts((current) => [...current, emptyFieldDraft()])}
          >
            Add field
          </SecondaryButton>
        </div>
        {error ? <p className="m-0 text-xs text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <SecondaryButton disabled={pending} onClick={props.onClose}>
            Cancel
          </SecondaryButton>
          <PrimaryButton
            data-testid="new-collection-create"
            disabled={pending || name.trim() === ""}
            onClick={() => void create()}
          >
            Create collection
          </PrimaryButton>
        </div>
      </div>
    </Overlay>
  );
}
