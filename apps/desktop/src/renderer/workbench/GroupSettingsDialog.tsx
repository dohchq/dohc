import { TriangleAlert } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { GroupRuleLevel } from "@dohc/security-contract/workspace-members";
import { Overlay } from "../Overlay";
import { basenameOf } from "../path";
import { GhostButton, PrimaryButton, RetryRow, SecondaryButton } from "../ui/controls";
import { SegmentedControl } from "../ui/SegmentedControl";
import { SkeletonRows } from "../ui/SkeletonRows";
import { useShownAfter } from "../ui/useShownAfter";

type MemberLevel = "view" | "comment" | "edit";

/** A Group's access as the relay lists it, or "no-members" when no one else is in the workspace. */
export type GroupAccess = { level: GroupRuleLevel | null; memberLevel: MemberLevel } | "no-members";

const OPTIONS = [
  { value: "comment", label: "Can post" },
  { value: "view", label: "View only" },
  { value: "none", label: "No access" },
] as const;

// A Group with no rule takes the member level: Comment and Edit post there.
const memberChoice = (level: MemberLevel): GroupRuleLevel =>
  level === "view" ? "view" : "comment";

/**
 * The Members picker. A null `level` follows the member level and says so.
 * A null `memberLevel` draws the picker off with nothing chosen, as when the
 * relay can't be reached.
 */
export function GroupAccessPicker(props: {
  level: GroupRuleLevel | null;
  memberLevel: MemberLevel | null;
  disabled?: boolean;
  onChange: (level: GroupRuleLevel | null) => void;
}) {
  const value = props.level ?? (props.memberLevel ? memberChoice(props.memberLevel) : "");
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] text-ink">Members</span>
        <SegmentedControl<GroupRuleLevel | "">
          label="Members"
          testId="chats-group-access-level"
          value={value}
          options={OPTIONS}
          disabled={props.disabled === true || props.memberLevel === null}
          onChange={(level) => {
            if (level !== "") props.onChange(level);
          }}
        />
      </div>
      {props.memberLevel === null ? null : props.level === null ? (
        <p data-testid="chats-group-access-follows" className="m-0 text-[12px] text-muted">
          Follows the member level.
        </p>
      ) : (
        <GhostButton
          data-testid="chats-group-access-follow"
          disabled={props.disabled}
          className="self-start"
          onClick={() => props.onChange(null)}
        >
          Follow the member level
        </GhostButton>
      )}
    </>
  );
}

// Who among the members can see and post in one Group. The owner and admins
// always post. A failed read offers Try again in place; a failed save keeps
// the dialog open with its error.
export function GroupSettingsDialog(props: {
  groupName: string;
  // The folder the Group was created with, if any.
  folderPath?: string;
  load: () => Promise<GroupAccess>;
  // Resolves to null once the relay took the change, or to why it didn't.
  // Null clears the Group's rule, so it takes the member level.
  save: (level: GroupRuleLevel | null) => Promise<string | null>;
  onOpenFolder?: (path: string) => void;
  onInviteMembers?: () => void;
  onClose: () => void;
}) {
  const [access, setAccess] = useState<GroupAccess | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [reads, setReads] = useState(0);
  // The picked level, "member" to follow the member level, or null for no change.
  const [chosen, setChosen] = useState<GroupRuleLevel | "member" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const loadRef = useRef(props.load);
  loadRef.current = props.load;
  const id = useId();

  useEffect(() => {
    let current = true;
    setReadFailed(false);
    setAccess(null);
    loadRef.current().then(
      (answer) => {
        if (current) setAccess(answer);
      },
      () => {
        if (current) setReadFailed(true);
      },
    );
    return () => {
      current = false;
    };
  }, [reads]);

  const loading = access === null && !readFailed;
  const skeletonShown = useShownAfter(loading, 150);
  const ready = access !== null && access !== "no-members" ? access : null;
  // The level Save sends: the picked one, else the Group's own.
  const next = chosen === null ? (ready?.level ?? null) : chosen === "member" ? null : chosen;
  const changed = ready !== null && next !== ready.level;
  const hiding = ready !== null && next === "none" && ready.level !== "none";
  const folderName = props.folderPath ? basenameOf(props.folderPath) : null;

  async function save() {
    if (busyRef.current || ready === null) return;
    if (!changed) {
      props.onClose();
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const failed = await props.save(next);
      if (failed === null) props.onClose();
      else setFailure(failed);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Overlay
      onClose={() => {
        if (!busyRef.current) props.onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-name`}
        data-testid="chats-group-settings-dialog"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="dohc-elevated flex w-[440px] max-w-[calc(100vw-2rem)] flex-col gap-6 rounded-xl border border-line bg-panel p-6"
      >
        <div className="flex flex-col gap-1">
          <h2 id={`${id}-title`} className="m-0 text-base font-semibold text-ink">
            Group settings
          </h2>
          <p id={`${id}-name`} className="m-0 truncate text-[13px] text-muted">
            {props.groupName}
          </p>
        </div>
        <section aria-labelledby={`${id}-access`} className="flex flex-col gap-2">
          <h3 id={`${id}-access`} className="dohc-section-label m-0">
            Access
          </h3>
          {readFailed ? (
            <RetryRow testId="chats-group-access-failed" onRetry={() => setReads((n) => n + 1)}>
              dohc could not load access.
            </RetryRow>
          ) : loading ? (
            skeletonShown ? (
              <SkeletonRows label="Loading access" rows={1} testId="chats-group-access-loading" />
            ) : (
              <div className="h-7" />
            )
          ) : access === "no-members" ? (
            <div
              data-testid="chats-group-access-alone"
              className="flex flex-wrap items-center gap-x-2 gap-y-1"
            >
              <p className="m-0 text-[13px] text-muted">Only you are in this workspace.</p>
              {props.onInviteMembers ? (
                <SecondaryButton size="compact" onClick={props.onInviteMembers}>
                  Invite members
                </SecondaryButton>
              ) : null}
            </div>
          ) : ready ? (
            <>
              <GroupAccessPicker
                level={next}
                memberLevel={ready.memberLevel}
                disabled={busy}
                onChange={(level) => {
                  setChosen(level ?? "member");
                  setFailure(null);
                }}
              />
              {hiding ? (
                <p
                  data-testid="chats-group-access-hiding"
                  className="m-0 flex items-start gap-1.5 text-[12px] text-muted"
                >
                  <TriangleAlert size={12} aria-hidden className="mt-0.5 shrink-0 text-warning" />
                  <span>
                    Members will no longer see {props.groupName}. People who read it may keep a
                    copy.
                  </span>
                </p>
              ) : null}
            </>
          ) : null}
          {folderName && props.folderPath ? (
            <p data-testid="chats-group-access-folder" className="m-0 text-[12px] text-muted">
              Files in{" "}
              {props.onOpenFolder ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    props.onOpenFolder?.(props.folderPath!);
                    props.onClose();
                  }}
                  className="cursor-pointer text-ink underline decoration-line underline-offset-2 hover:decoration-ink"
                >
                  {folderName}
                </button>
              ) : (
                <span className="text-ink">{folderName}</span>
              )}{" "}
              follow that folder&apos;s own access rule.
            </p>
          ) : null}
        </section>
        <div className="flex flex-col gap-3">
          {failure ? (
            <p
              role="alert"
              data-testid="chats-group-access-error"
              className="m-0 flex items-start gap-2 text-[12px] text-danger"
            >
              <TriangleAlert size={14} aria-hidden className="mt-px shrink-0" />
              {failure}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <SecondaryButton
              data-testid="chats-group-settings-cancel"
              disabled={busy}
              onClick={props.onClose}
            >
              Cancel
            </SecondaryButton>
            <PrimaryButton
              type="submit"
              data-testid="chats-group-settings-save"
              disabled={ready === null || busy}
            >
              {busy ? "Saving…" : "Save"}
            </PrimaryButton>
          </div>
        </div>
      </form>
    </Overlay>
  );
}
