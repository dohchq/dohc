import { AtSign, Folder, FolderX, LockKeyhole, Plus, Trash2, X } from "lucide-react";
import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { MembersRequest } from "@dohc/cli/members";
import {
  FOLDER_RULE_CHANGED,
  type MemberLevel,
  type WorkspaceFolderRule,
  type WorkspaceMembersView,
  type WorkspacePerson,
} from "@dohc/security-contract/workspace-members";
import { normalizeRuleEmail, prepareFolderRulePath } from "@dohc/security-contract/access-rules";
import { isSharedWithMePath } from "@dohc/workspace-core";
import { bridge } from "../bridge";
import { Overlay } from "../Overlay";
import {
  ConfirmActions,
  ConfirmationCard,
  ConfirmDialog,
  confirmPanel,
  useOpeningFocus,
} from "../ui/ConfirmDialog";
import { CopyButton } from "../ui/CopyButton";
import {
  EmptyState,
  FieldError,
  GhostButton,
  IconButton,
  PrimaryButton,
  SecondaryButton,
} from "../ui/controls";
import { SegmentedControl } from "../ui/SegmentedControl";
import { SuggestInput, type Suggestion } from "../ui/SuggestInput";
import { useWorkspaceQuery } from "../workspace/useWorkspaceQuery";
import { useWorkspaceSession } from "../workspace/workspaceSession";
import { SettingRow } from "./SettingRow";

type Access = Pick<WorkspaceFolderRule, "members" | "people">;
type Edit = { kind: "add" | "marker" } | { kind: "change" | "remove"; rule: WorkspaceFolderRule };
const LEVELS = { none: "None", view: "View", comment: "Comment", edit: "Edit" } as const;
const RANK = { none: 0, view: 1, comment: 2, edit: 3 } as const;
const STATE = {
  covered: "Covered",
  "marker-missing": "Marker missing",
  "folder-missing": "Folder missing",
};
const LEVEL_OPTIONS = Object.entries(LEVELS).map(([value, label]) => ({
  value: value as keyof typeof LEVELS,
  label,
}));
const selectClass =
  "h-8 shrink-0 rounded-md border border-line bg-bg pl-2 pr-1 text-[13px] text-ink focus:border-ink";
const pathName = (path: string) => path || "Workspace root";

// The folders a rule can name: every folder in the workspace's listing, but
// not dohc's own or hidden ones, and not shares accepted from other people.
function ruleFolders(listing: { files: ReadonlyArray<{ path: string }>; folders?: string[] }) {
  const folders = new Set<string>();
  const add = (path: string, depth: number) => {
    const parts = path.split("/").slice(0, depth);
    for (let at = 1; at <= parts.length; at += 1) {
      const folder = parts.slice(0, at).join("/");
      if (parts[at - 1]!.startsWith(".") || isSharedWithMePath(folder)) return;
      folders.add(folder);
    }
  };
  for (const folder of listing.folders ?? []) add(folder, Infinity);
  for (const { path } of listing.files) add(path, path.split("/").length - 1);
  return [...folders].sort((left, right) => left.localeCompare(right));
}

function narrows(before: Access, after: Access): boolean {
  if (RANK[after.members ?? "none"] < RANK[before.members ?? "none"]) return true;
  const old = new Map(before.people.map(({ email, level }) => [normalizeRuleEmail(email), level]));
  const next = new Map(after.people.map(({ email, level }) => [normalizeRuleEmail(email), level]));
  return [...new Set([...old.keys(), ...next.keys()])].some(
    (email) =>
      RANK[next.get(email) ?? after.members ?? "none"] <
      RANK[old.get(email) ?? before.members ?? "none"],
  );
}

function inheritedAccess(view: WorkspaceMembersView, folder: string): Access {
  const path = prepareFolderRulePath(folder);
  let access: Access = { members: view.memberLevel, people: [] };
  if (path === null) return access;
  let depth = -1;
  for (const rule of view.folderRules ?? []) {
    for (const entry of rule.folders) {
      if (entry.path.length <= depth || entry.path === path) continue;
      if (entry.path === "" || path.startsWith(`${entry.path}/`)) {
        access = rule;
        depth = entry.path.length;
      }
    }
  }
  return access;
}

export function FolderAccessSettings(props: {
  /** The open workspace, whose folders the dialogs suggest. */
  workspaceId: string;
  view: WorkspaceMembersView;
  rules: WorkspaceFolderRule[];
  busy: boolean;
  run: (request: MembersRequest, onFailure: (message: string) => void) => Promise<boolean>;
  reload: () => void;
}) {
  const [edit, setEdit] = useState<Edit | null>(null);
  return (
    <section aria-label="Folder access" className="mt-8">
      <header className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <h4 className="m-0 text-sm font-semibold text-ink">Folder access</h4>
        <div className="flex gap-2">
          <SecondaryButton disabled={props.busy} onClick={() => setEdit({ kind: "marker" })}>
            Remove marker
          </SecondaryButton>
          <SecondaryButton
            className="inline-flex items-center gap-1"
            disabled={props.busy}
            onClick={() => setEdit({ kind: "add" })}
          >
            <Plus size={14} aria-hidden />
            Add
          </SecondaryButton>
        </div>
      </header>
      <div className="rounded-lg border border-line bg-panel px-5">
        {props.rules.length === 0 ? (
          <div className="py-4">
            <EmptyState icon={Folder} title="No folder access rules yet." />
          </div>
        ) : (
          props.rules.map((rule) => (
            <SettingRow
              key={rule.ruleId}
              title={`Members · ${LEVELS[rule.members ?? "none"]}`}
              aside={
                <>
                  <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
                    {rule.folders.map(({ path, state }) => {
                      const Icon = state === "covered" ? Folder : FolderX;
                      return (
                        <li key={path} className="flex flex-wrap items-center gap-x-2">
                          <Icon size={14} aria-hidden className="shrink-0 text-muted" />
                          <span className="wrap-anywhere text-ink">{pathName(path)}</span>
                          <span className="text-[12px] text-muted">{STATE[state]}</span>
                        </li>
                      );
                    })}
                  </ul>
                  {rule.people.map(({ email, level }) => (
                    <div key={email} className="mt-1 wrap-anywhere text-[12px] text-muted">
                      {email} · {LEVELS[level]}
                    </div>
                  ))}
                </>
              }
            >
              <SecondaryButton
                disabled={props.busy}
                onClick={() => setEdit({ kind: "change", rule })}
              >
                Change
              </SecondaryButton>
              <SecondaryButton
                disabled={props.busy}
                onClick={() => setEdit({ kind: "remove", rule })}
              >
                Remove
              </SecondaryButton>
            </SettingRow>
          ))
        )}
      </div>
      {edit ? (
        <FolderAccessDialog
          workspaceId={props.workspaceId}
          people={props.view.people}
          edit={edit}
          busy={props.busy}
          run={props.run}
          inherited={(path) => inheritedAccess(props.view, path)}
          close={() => setEdit(null)}
          reload={props.reload}
        />
      ) : null}
    </section>
  );
}

function FolderAccessDialog(props: {
  workspaceId: string;
  people: WorkspacePerson[];
  edit: Edit;
  busy: boolean;
  run: Parameters<typeof FolderAccessSettings>[0]["run"];
  inherited: (path: string) => Access;
  close: () => void;
  reload: () => void;
}) {
  const { edit, busy, close } = props;
  const id = useId();
  const rule = "rule" in edit ? edit.rule : null;
  const marker = edit.kind === "marker";
  const remove = edit.kind === "remove";
  const accessForm = !marker && !remove;
  const [folder, setFolder] = useState("");
  const [pickedLevel, setPickedLevel] = useState<MemberLevel | "none" | undefined>(
    rule ? (rule.members ?? "none") : undefined,
  );
  const [people, setPeople] = useState(rule?.people ?? []);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<MembersRequest | null>(null);
  const stale = failure === FOLDER_RULE_CHANGED;
  const panelRef = useRef<HTMLDivElement>(null);
  // Change starts on the member level, the first thing it can change.
  useOpeningFocus(() =>
    rule && accessForm
      ? panelRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')
      : null,
  );
  const title = marker
    ? "Remove an unknown marker"
    : remove
      ? "Remove folder access rule?"
      : rule
        ? "Change folder access"
        : "Add folder access";
  const label = marker ? "Remove marker" : remove ? "Remove rule" : "Save";
  const before = rule ?? props.inherited(folder);
  // Rules never limit the owner or admins, so only members are offered.
  const personSuggestions = useMemo<Suggestion[]>(
    () =>
      props.people.flatMap(({ role, state, name, email }) =>
        role === "member" && state !== "removed" && email
          ? [{ value: normalizeRuleEmail(email), label: name ?? email, detail: name ? email : "" }]
          : [],
      ),
    [props.people],
  );
  const chosen = new Set(people.map(({ email }) => normalizeRuleEmail(email)));
  const members = pickedLevel ?? before.members ?? "none";

  const send = async (request: MembersRequest) => {
    setFailure(null);
    if (await props.run(request, setFailure)) close();
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || stale) return;
    const version = rule ? { ruleId: rule.ruleId, revision: rule.revision } : null;
    const emails = new Set<string>();
    const badEmail = people.findIndex(({ email }) => {
      const key = normalizeRuleEmail(email);
      if (!/^[^\s@]+@[^\s@]+$/u.test(key) || emails.has(key)) return true;
      emails.add(key);
      return false;
    });
    const badField =
      !rule && !folder.trim()
        ? "folder"
        : accessForm && badEmail >= 0
          ? `person-${badEmail}`
          : null;
    setInvalid(badField);
    if (badField) {
      const field = event.currentTarget.elements.namedItem(badField);
      if (field instanceof HTMLElement) field.focus();
      return;
    }
    if (marker) {
      void send({ action: "folderMarker", folder });
    } else if (remove && version) {
      void send({ action: "folder", change: { ...version, clear: true } });
    } else {
      const next: Access = { members: members === "none" ? null : members, people };
      const request: MembersRequest = {
        action: "folder",
        change: { ...(version ?? { folder, create: true }), ...next },
      };
      if (narrows(before, next)) setConfirm(request);
      else void send(request);
    }
  };

  return (
    <>
      <Overlay
        panelRef={panelRef}
        onClose={() => {
          if (!busy) close();
        }}
        panelProps={confirmPanel(`${id}-title`)}
      >
        <ConfirmationCard icon={marker || remove ? Trash2 : LockKeyhole}>
          <h2 id={`${id}-title`} className="m-0 text-base font-semibold text-ink">
            {title}
          </h2>
          <form className="flex min-w-0 flex-col gap-6" onSubmit={submit} noValidate>
            <div className="flex min-w-0 flex-col gap-4">
              {rule ? (
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
                  {rule.folders.map(({ path }) => (
                    <li key={path} className="flex items-center gap-2">
                      <Folder size={14} aria-hidden className="shrink-0 text-muted" />
                      <span className="wrap-anywhere text-ink">{pathName(path)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex flex-col gap-2">
                  <label htmlFor={`${id}-folder-field`} className="text-[13px] text-ink">
                    Folder path
                  </label>
                  <FolderField
                    id={`${id}-folder-field`}
                    workspaceId={props.workspaceId}
                    value={folder}
                    onChange={(value) => {
                      setFolder(value);
                      setInvalid(null);
                    }}
                    disabled={busy}
                    invalid={invalid === "folder"}
                    describedBy={invalid === "folder" ? `${id}-folder` : undefined}
                  />
                  {invalid === "folder" ? (
                    <FieldError id={`${id}-folder`}>
                      Enter a workspace-relative path, or / for the workspace root.
                    </FieldError>
                  ) : null}
                </div>
              )}
              {remove ? (
                <p className="m-0 text-[13px] text-muted">
                  Copies already on people's computers stay.
                </p>
              ) : null}
              {accessForm ? (
                <>
                  <div className="flex flex-col gap-2">
                    <span aria-hidden className="text-[13px] text-ink">
                      Member level
                    </span>
                    <SegmentedControl
                      label="Member level"
                      value={members}
                      options={LEVEL_OPTIONS}
                      onChange={setPickedLevel}
                      disabled={busy}
                    />
                  </div>
                  <fieldset
                    disabled={busy}
                    className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
                  >
                    <legend className="mb-2 p-0 text-[13px] text-ink">People</legend>
                    {people.map(({ email, level }, index) => (
                      <div key={index} className="flex flex-col gap-1">
                        <div className="flex items-center gap-2">
                          <SuggestInput
                            label="Email address"
                            listLabel="People"
                            icon={AtSign}
                            type="email"
                            name={`person-${index}`}
                            value={email}
                            maxLength={320}
                            placeholder="sam@example.com"
                            autoFocus={email === "" && index === people.length - 1}
                            suggestions={personSuggestions.filter(
                              (option) =>
                                option.value === normalizeRuleEmail(email) ||
                                !chosen.has(option.value),
                            )}
                            disabled={busy}
                            invalid={invalid === `person-${index}`}
                            describedBy={invalid === `person-${index}` ? `${id}-person` : undefined}
                            onChange={(value) => {
                              setPeople(
                                people.map((person, at) =>
                                  at === index ? { ...person, email: value } : person,
                                ),
                              );
                              setInvalid(null);
                            }}
                          />
                          <select
                            aria-label="Access"
                            className={selectClass}
                            value={level}
                            onChange={(event) =>
                              setPeople(
                                people.map((person, at) =>
                                  at === index
                                    ? { ...person, level: event.target.value as MemberLevel }
                                    : person,
                                ),
                              )
                            }
                          >
                            <option value="view">View</option>
                            <option value="comment">Comment</option>
                            <option value="edit">Edit</option>
                          </select>
                          <IconButton
                            type="button"
                            aria-label="Remove person"
                            title="Remove person"
                            onClick={() => {
                              setPeople(people.filter((_, at) => at !== index));
                              setInvalid(null);
                            }}
                          >
                            <X size={14} aria-hidden />
                          </IconButton>
                        </div>
                        {invalid === `person-${index}` ? (
                          <FieldError id={`${id}-person`}>
                            Enter a different, valid email address for each person.
                          </FieldError>
                        ) : null}
                      </div>
                    ))}
                    <GhostButton
                      type="button"
                      // The hover fill hangs outside the column's edge.
                      className="-ml-2 self-start"
                      disabled={people.length >= 1000}
                      onClick={() => setPeople([...people, { email: "", level: "view" }])}
                    >
                      <Plus size={14} aria-hidden />
                      Add person
                    </GhostButton>
                  </fieldset>
                </>
              ) : null}
              {failure ? (
                <div className="flex items-start gap-2">
                  <FieldError id={`${id}-failure`}>{failure}</FieldError>
                  <CopyButton getText={() => failure} label="Copy error" iconOnly />
                </div>
              ) : null}
            </div>
            <ConfirmActions>
              <SecondaryButton type="button" onClick={close} disabled={busy}>
                Cancel
              </SecondaryButton>
              {stale ? (
                <PrimaryButton
                  type="button"
                  onClick={() => {
                    close();
                    props.reload();
                  }}
                >
                  Reload Members
                </PrimaryButton>
              ) : (
                <PrimaryButton type="submit" disabled={busy}>
                  {busy ? (accessForm ? "Saving…" : "Removing…") : label}
                </PrimaryButton>
              )}
            </ConfirmActions>
          </form>
        </ConfirmationCard>
      </Overlay>
      {confirm ? (
        <ConfirmDialog
          icon={LockKeyhole}
          title="Limit access to this folder?"
          confirmLabel="Limit access"
          testId="folder-access-confirm"
          cancelTestId="folder-access-cancel"
          confirmTestId="folder-access-limit"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            setConfirm(null);
            void send(confirm);
          }}
        >
          Copies already on people's computers stay.
        </ConfirmDialog>
      ) : null}
    </>
  );
}

const ROOT: Suggestion = { value: "/", label: "Workspace root" };

function FolderField(props: {
  id: string;
  workspaceId: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  invalid: boolean;
  describedBy: string | undefined;
}) {
  const listing = useWorkspaceQuery(useWorkspaceSession(), {
    key: `folder-access-folders:${props.workspaceId}`,
    load: () => bridge().listWorkspaceFiles({ workspaceId: props.workspaceId }),
  });
  const suggestions = useMemo<Suggestion[]>(
    () => [
      ROOT,
      ...(listing.value ? ruleFolders(listing.value) : []).map((path) => ({
        value: path,
        label: path,
      })),
    ],
    [listing.value],
  );
  return (
    <SuggestInput
      id={props.id}
      name="folder"
      listLabel="Folders"
      icon={Folder}
      value={props.value}
      onChange={props.onChange}
      suggestions={suggestions}
      maxLength={4096}
      placeholder="Projects/Research"
      autoFocus
      disabled={props.disabled}
      invalid={props.invalid}
      describedBy={props.describedBy}
    />
  );
}
