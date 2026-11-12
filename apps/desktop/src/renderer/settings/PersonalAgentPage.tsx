import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, Clock, Eye, Link, LogIn, LogOut, MessageSquare, Minus, Package, Palette, Pencil, Trash2 } from "lucide-react";
import { normalizeShareDiscussionDisplayName, SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT } from "@dohc/security-contract/share-discussion";
import {
  PERSONAL_AGENT_REACH_LIMIT,
  type PersonalAgent,
  type PersonalAgentChange,
  type PersonalAgentChangeResult,
  type PersonalAgentLevel,
  type PersonalAgentRoster,
  type PersonalAgentsAccount,
} from "../../ipc/bridgeContract";
import { agentHandle } from "../../settings/userSettings";
import { AgentLinkAppMenu } from "../agentLinkApps";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { Overlay } from "../Overlay";
import { relativeTime } from "../relativeTime";
import { formatChatTime } from "../time";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { PrimaryButton, SecondaryButton } from "../ui/controls";
import { CopyButton } from "../ui/CopyButton";
import { Menu, MENU_SEPARATOR, type MenuEntry } from "../ui/Menu";
import { SegmentedControl } from "../ui/SegmentedControl";
import { ChatAvatar } from "../workbench/ChatAvatar";
import { BOX, PageRow, ROW, SECTION, VALUE } from "./AgentPage";
import { HueControl } from "./SettingRow";

type Reach = "none" | PersonalAgentLevel;

export const NAME_TAKEN = "Another agent has this name.";

const REACH_OPTIONS = [
  { value: "none", label: "None" },
  { value: "view", label: "View" },
  { value: "comment", label: "Comment" },
  { value: "edit", label: "Edit" },
] as const;

const REACH_SHOWN = {
  none: { icon: Minus, label: "None" },
  view: { icon: Eye, label: "View" },
  comment: { icon: MessageSquare, label: "Comment" },
  edit: { icon: Pencil, label: "Edit" },
} as const;

// What each level lets the agent do, in the sign-in screen's words.
const REACH_MEANINGS ="View reads files and chats. Comment also posts in chats and Comments. " +
  "Edit also changes Collections, but no other files.";

/** One personal agent and the server account that holds it. */
export type PersonalEntry = { account: PersonalAgentsAccount; roster: PersonalAgentRoster; agent: PersonalAgent };

/** Every personal agent of every account whose roster dohc has read, in the account's order. */
export function personalEntries(accounts: readonly PersonalAgentsAccount[]): PersonalEntry[] {
  return accounts.flatMap((account) => {
    const roster = account.roster;
    return roster === null ? [] : roster.agents.map((agent) => ({ account, roster, agent }));
  });
}

/** Whether this workspace syncs to the account's server, which an agent link needs. */
export function syncsTo(roster: PersonalAgentRoster | null, workspaceId: string): boolean {
  return roster?.workspaces.some((workspace) => workspace.workspaceId === workspaceId) ?? false;
}

/** The link an agent signs in with to reach this workspace. */
export function agentLink(account: Pick<PersonalAgentsAccount, "agentLinkOrigin">, workspaceId: string): string {
  return `${account.agentLinkOrigin}/mcp/agent/w/${encodeURIComponent(workspaceId)}`;
}

/** Why a personal agent can't take this name, or null when it can. */
export function personalNameProblem(value: string, taken: (name: string) => boolean): string | null {
  const name = normalizeShareDiscussionDisplayName(value);
  if (!name.ok) return name.reason === "empty" ? "Enter an agent name." : `Use ${SHARE_DISCUSSION_NAME_CODE_POINT_LIMIT} characters or fewer.`;
  return taken(name.value) ? NAME_TAKEN : null;
}

// The product and version the agent's program reported, or null when it reported neither.
function reportedWords(agent: Pick<PersonalAgent, "reportedProduct" | "reportedVersion">): string | null {
  const parts = [agent.reportedProduct, agent.reportedVersion].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** The relay's answer to one change, or the words a failed call gives. */
export async function changePersonalAgent(
  account: PersonalAgentsAccount,
  agent: PersonalAgent,
  change: PersonalAgentChange,
  failure: string,
): Promise<PersonalAgentChangeResult> {
  try {
    return await bridge().changePersonalAgent({ accountKey: account.accountKey, agentId: agent.agentId, change });
  } catch (cause) {
    return { ok: false, error: ipcErrorMessage(cause, failure) };
  }
}

/** Choose what an agent can reach in each workspace the account owns on its server. */
export function PersonalReachSheet(props: {
  account: PersonalAgentsAccount;
  roster: PersonalAgentRoster;
  agent: PersonalAgent;
  onClose: () => void;
  // The save's answer after the sheet closed: its toast, when it failed.
  onLateFailure: (message: string) => void;
}) {
  const { agent, roster } = props;
  const id = useId();
  const [choices, setChoices] = useState<ReadonlyMap<string, Reach>>(() =>
    new Map(roster.workspaces.map((workspace) => [
      workspace.workspaceId,
      agent.reach.find((entry) => entry.workspaceId === workspace.workspaceId)?.level ?? "none",
    ] as const)));
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const open = useRef(true);
  useEffect(() => () => { open.current = false; }, []);
  const save = async () => {
    if (saving) return;
    const reach = [...choices].flatMap(([workspaceId, level]) => (level === "none" ? [] : [{ workspaceId, level }]));
    if (reach.length > PERSONAL_AGENT_REACH_LIMIT) {
      setFailure(`Choose up to ${PERSONAL_AGENT_REACH_LIMIT} workspaces.`);
      return;
    }
    setSaving(true);
    setFailure(null);
    const result = await changePersonalAgent(props.account, agent, { kind: "reach", reach }, "dohc could not save the reach.");
    if (!open.current) {
      if (!result.ok) props.onLateFailure(result.error);
      return;
    }
    setSaving(false);
    if (result.ok) props.onClose();
    else setFailure(result.error);
  };
  return (
    <Overlay onClose={saving ? undefined : props.onClose}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        data-testid="personal-agent-reach-sheet"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="dohc-elevated dohc-pop-in flex w-[min(520px,calc(100vw-32px))] flex-col gap-4 rounded-xl border border-line bg-panel p-5"
      >
        <div className="flex flex-col gap-1">
          <h2 id={`${id}-title`} className="m-0 break-words text-base font-semibold text-ink">Change what {agent.name} can reach</h2>
          <p className="m-0 text-[12px] text-muted">{REACH_MEANINGS}</p>
        </div>
        {roster.workspaces.length === 0 ? (
          <p className="m-0 text-[13px] text-muted">Sync a workspace to {props.account.host} to let {agent.name} reach it.</p>
        ) : (
          <div className="max-h-[min(360px,50vh)] overflow-y-auto rounded-lg border border-line bg-bg">
            {roster.workspaces.map((workspace) => {
              const name = workspace.name ?? "Unnamed workspace";
              return (
                <div key={workspace.workspaceId} data-testid="personal-agent-reach-row" className={ROW}>
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{name}</span>
                  <span className="shrink-0">
                    <SegmentedControl
                      label={`What ${agent.name} can do in ${name}`}
                      testId={`personal-agent-reach-${workspace.workspaceId}`}
                      value={choices.get(workspace.workspaceId) ?? "none"}
                      options={REACH_OPTIONS}
                      disabled={saving}
                      onChange={(level) => setChoices((current) => new Map(current).set(workspace.workspaceId, level))}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {failure ? (
          <p role="alert" data-testid="personal-agent-reach-error" className="m-0 flex items-start gap-1.5 text-[12px] text-danger">
            <CircleAlert size={12} aria-hidden className="mt-0.5 shrink-0" />
            <span className="min-w-0">{failure}</span>
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <SecondaryButton data-testid="personal-agent-reach-cancel" disabled={saving} onClick={props.onClose}>Cancel</SecondaryButton>
          <PrimaryButton type="submit" data-testid="personal-agent-reach-save" disabled={saving}>
            {saving ? "Saving…" : "Save reach"}
          </PrimaryButton>
        </div>
      </form>
    </Overlay>
  );
}

/**
 * A personal agent's page in Settings › Agents. The agent signed in through
 * an agent link and lives on its server account, so every change saves there
 * and every computer on the account shows it. While it is signed in, the page
 * shows what it can reach and how to sign it out. Once it is signed out, it
 * reaches nothing, and the page offers the link that signs it in again.
 */
export function PersonalAgentPage(props: {
  entry: PersonalEntry;
  workspaceId: string;
  // The rename field, shown in place of the name.
  nameField: ReactNode | null;
  onRename: () => void;
  onRemove: () => void;
  // Saves one change, and says why in Notices when it fails.
  onChange: (change: PersonalAgentChange, failure: string) => Promise<boolean>;
  onError?: (message: string) => void;
  onBack: () => void;
  backRef?: Ref<HTMLButtonElement>;
}) {
  const { account, roster, agent } = props.entry;
  const [menuOpen, setMenuOpen] = useState(false);
  const [reaching, setReaching] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const signedOut = agent.status === "signed_out";
  const handle = agentHandle(agent.name);
  const reported = reportedWords(agent);
  const synced = syncsTo(roster, props.workspaceId);
  const signedIn = agent.signedInAtMs === null ? null : formatChatTime(agent.signedInAtMs);
  const level = (workspaceId: string): Reach => agent.reach.find((entry) => entry.workspaceId === workspaceId)?.level ?? "none";

  return (
    <section data-testid="agent-page" data-agent-id={agent.agentId} data-status={agent.status} aria-label={agent.name}>
      <button
        ref={props.backRef}
        type="button"
        data-testid="agent-back"
        onClick={props.onBack}
        className="-ml-1 mb-4 inline-flex items-center gap-1 rounded px-1 text-[13px] text-muted hover:text-ink"
      >
        <ChevronLeft size={14} aria-hidden />Agents
      </button>
      <div className="flex items-center gap-3">
        {/* A signed-out agent's header dims, as its row does. */}
        <ChatAvatar name={agent.name} kind="agent" presentation={{ group: "", hue: agent.hue === "olive" ? null : agent.hue, self: false }} size="post"
          className={signedOut ? "opacity-50" : undefined} />
        <div className={`min-w-0 flex-1 ${signedOut ? "opacity-50" : ""}`}>
          {props.nameField ?? (
            <button type="button" title="Rename" aria-label={`Rename ${agent.name}`} onClick={props.onRename}
              className="block min-w-0 max-w-full truncate rounded text-left text-[15px] font-semibold text-ink">
              {agent.name}
            </button>
          )}
          {props.nameField ? null : (
            <p data-testid="agent-page-subtitle" className="m-0 mt-0.5 flex flex-wrap items-center gap-1 text-[12px] text-muted">
              {handle ? <>
                <span className="font-mono">@{handle}</span>
                <span aria-hidden className="text-subtle">·</span>
              </> : null}
              <span className="inline-flex items-center gap-1"><Link size={12} aria-hidden />Through agent link</span>
              <span aria-hidden className="text-subtle">·</span>
              <span className="min-w-0 truncate">{account.host}</span>
              {signedOut ? <>
                <span aria-hidden className="text-subtle">·</span>
                <span>Signed out</span>
              </> : null}
            </p>
          )}
        </div>
        <Menu
          label={`${agent.name} actions`}
          testId="agent-menu"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          width={200}
          items={[
            { id: "rename", label: "Rename", icon: <Pencil size={14} aria-hidden />, onSelect: props.onRename },
            // Remove waits for sign-out, so an agent at work never just goes.
            ...(signedOut ? [
              MENU_SEPARATOR,
              { id: "remove", label: "Remove", icon: <Trash2 size={14} aria-hidden />, danger: true, onSelect: props.onRemove },
            ] satisfies MenuEntry[] : []),
          ]}
        />
      </div>

      <div data-testid="personal-agent-color" className={`${BOX} mt-5`}>
        <PageRow icon={<Palette size={14} />} label="Color" wrap>
          <span className="ml-auto">
            <HueControl label={`Color of ${agent.name}`} shape="agent" value={agent.hue}
              onChange={(hue) => void props.onChange({ kind: "hue", hue }, `dohc could not change ${agent.name}'s color.`)} />
          </span>
        </PageRow>
      </div>

      {/* A signed-out agent reaches nothing, so its page has no reach. */}
      {signedOut ? null : <>
        <div className="mb-1.5 mt-5 flex min-h-6 items-center gap-2">
          <h4 className="m-0 mr-auto text-[12px] font-medium text-subtle">Reach</h4>
          {roster.workspaces.length > 0 ? (
            <SecondaryButton data-testid="personal-agent-reach" size="row" aria-label={`Change what ${agent.name} can reach`} onClick={() => setReaching(true)}>
              Change
            </SecondaryButton>
          ) : null}
        </div>
        {roster.workspaces.length === 0 ? (
          <p className="m-0 text-[12px] text-muted">Sync a workspace to {account.host} to let {agent.name} reach it.</p>
        ) : (<>
          <div data-testid="personal-agent-reach-list" className={BOX}>
            {/* None rows stay, so the page lists every workspace Change offers. */}
            {roster.workspaces.map((workspace) => {
              const shown = REACH_SHOWN[level(workspace.workspaceId)];
              const Icon = shown.icon;
              return (
                <PageRow key={workspace.workspaceId} testId="personal-agent-reach-entry" label={workspace.name ?? "Unnamed workspace"}>
                  <span className={`${VALUE} ${shown.label === "None" ? "text-subtle" : ""}`}>
                    <Icon size={12} aria-hidden />{shown.label}
                  </span>
                </PageRow>
              );
            })}
          </div>
          <p data-testid="personal-agent-reach-meanings" className="m-0 mt-1.5 text-[12px] text-muted">{REACH_MEANINGS}</p>
        </>)}
      </>}

      <h4 className={SECTION}>Activity</h4>
      <div data-testid="personal-agent-activity" className={BOX}>
        {signedIn ? (
          <PageRow icon={<LogIn size={14} />} label="Signed in">
            <span className={VALUE}><time dateTime={signedIn.iso}>{signedIn.label}</time></span>
          </PageRow>
        ) : null}
        <PageRow icon={<Clock size={14} />} label="Last action">
          <span className={VALUE}>{agent.lastActionAtMs === null ? "None yet" : relativeTime(agent.lastActionAtMs)}</span>
        </PageRow>
        {reported ? (
          <PageRow icon={<Package size={14} />} label="Product">
            <span className={VALUE}>
              <span className="min-w-0 break-words">{reported} <span className="text-subtle">as reported</span></span>
            </span>
          </PageRow>
        ) : null}
      </div>

      <div className={`${BOX} mt-5`}>
        {signedOut ? (
          <PageRow icon={<LogIn size={14} />} label="Sign in again">
            <span className={VALUE}>
              <CopyButton
                key={props.workspaceId}
                label="Copy agent link"
                size="button"
                testId="personal-agent-link-copy"
                disabled={!synced}
                getText={() => (synced ? agentLink(account, props.workspaceId) : null)}
              />
              <AgentLinkAppMenu
                link={synced ? agentLink(account, props.workspaceId) : null}
                server="dohc-personal"
                testId="personal-agent-link-apps"
              />
            </span>
          </PageRow>
        ) : (
          <button
            type="button"
            data-testid="personal-agent-sign-out"
            onClick={() => setSigningOut(true)}
            className={`${ROW} w-full rounded-lg text-left transition-colors hover:bg-hover`}
          >
            <LogOut size={14} aria-hidden className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 text-[13px] text-ink">Sign out</span>
            <ChevronRight size={14} aria-hidden className="shrink-0 text-subtle" />
          </button>
        )}
      </div>
      {signedOut && !synced ? (
        <p data-testid="personal-agent-link-reason" className="m-0 mt-2 text-[12px] text-muted">
          Sync this workspace to {account.host} to give an agent a link.
        </p>
      ) : null}

      {reaching ? (
        <PersonalReachSheet
          account={account}
          roster={roster}
          agent={agent}
          onClose={() => setReaching(false)}
          onLateFailure={(message) => props.onError?.(message)}
        />
      ) : null}
      {signingOut ? (
        <ConfirmDialog
          title={`Sign out ${agent.name}?`}
          icon={LogOut}
          confirmLabel="Sign out"
          testId="personal-agent-sign-out-dialog"
          cancelTestId="personal-agent-sign-out-cancel"
          confirmTestId="personal-agent-sign-out-confirm"
          onCancel={() => setSigningOut(false)}
          onConfirm={() => {
            setSigningOut(false);
            void props.onChange({ kind: "sign-out" }, `dohc could not sign out ${agent.name}.`);
          }}
        >
          <p className="m-0">Its posts and changes stay in History.</p>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
