import { accountWords, type ServerProblemKind } from "@dohc/interface-words/account";
import { confirmWords } from "@dohc/interface-words/confirmations";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { useAccount, useSignIn } from "../src/account/AccountProvider";
import { ProblemLine } from "../src/account/ProblemLine";
import { AgentMark } from "../src/AgentMark";
import { workspaceName } from "../src/chats/Workspaces";
import { confirm } from "../src/confirm";
import type { SignIn } from "../src/server/account";
import { changeAgent, endSession, listAgents, listSessions, type AccountSession, type PersonalAgent, type PersonalRoster } from "../src/server/api";
import { requestGenerations, ServerError, shownProblem, type ServerClient } from "../src/server/client";
import { serverName } from "../src/server/origin";
import { useTheme } from "../src/theme";
import { signedInOnly } from "../src/sampleOnly";

type Load<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T; readonly problem: ServerProblemKind | null }
  | { readonly status: "failed"; readonly problem: ServerProblemKind };

// A list Settings reads from the server. Each read replaces the one before it, and nothing lands once the sign-in
// has ended.
function useServerList<T>(signIn: SignIn, read: (client: ServerClient) => Promise<T>) {
  const [load, setLoad] = useState<Load<T>>({ status: "loading" });
  const requests = useRef(requestGenerations());
  const reload = useCallback(() => {
    const request = requests.current.next();
    read(signIn.client).then(
      value => {
        if (signIn.isCurrent() && requests.current.isLatest(request)) setLoad({ status: "ready", value, problem: null });
      },
      (error: unknown) => {
        const problem = shownProblem(error);
        if (!signIn.isCurrent() || !requests.current.isLatest(request) || problem === null) return;
        setLoad(previous => previous.status === "ready" ? { ...previous, problem } : { status: "failed", problem });
      },
    );
  }, [signIn, read]);
  useEffect(reload, [reload]);
  /**
   * Applies a change's answer to the list. A read still in flight started before the change and could land over it, so
   * it no longer counts. Nothing reads again: the server leaves removed agents out, and a fresh read would take away
   * their Restore.
   */
  const update = useCallback((change: (value: T) => T) => {
    if (!signIn.isCurrent()) return;
    requests.current.next();
    setLoad(previous => previous.status === "ready" ? { status: "ready", value: change(previous.value), problem: null } : previous);
  }, [signIn]);
  /** Shows a change's failure in the list's place. Something gone or changed elsewhere reads the list again. */
  const fail = useCallback((error: unknown) => {
    if (!signIn.isCurrent()) return;
    if (error instanceof ServerError && (error.problem === "not-found" || error.problem === "refused")) {
      reload();
      return;
    }
    const problem = shownProblem(error);
    if (problem !== null) setLoad(previous => previous.status === "ready" ? { ...previous, problem } : previous);
  }, [signIn, reload]);
  return { load, reload, update, fail };
}

// A signed-in build's Settings, from your mark in the Chats header: the account and its server, which workspaces show
// on this phone, the account's sessions and agents, and Sign out.
function SettingsScreen() {
  const theme = useTheme();
  const signIn = useSignIn();
  const { account, workspaces, reloadWorkspaces, setShowOnPhone } = useAccount();
  const server = serverName(signIn.origin);
  const sessions = useServerList(signIn, listSessions);
  const agents = useServerList(signIn, listAgents);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  // One action at a time per row; a second tap while it runs does nothing.
  const act = useCallback(async (key: string, run: () => Promise<void>) => {
    if (pending.has(key)) return;
    setPending(previous => new Set(previous).add(key));
    try {
      await run();
    } finally {
      if (signIn.isCurrent()) setPending(previous => { const next = new Set(previous); next.delete(key); return next; });
    }
  }, [pending, signIn]);

  const signOut = useCallback(async () => {
    if (await confirm({ title: accountWords.signOutTitle(server), message: accountWords.signOutBody, confirm: accountWords.signOut, destructive: true })) {
      void account.signOut();
    }
  }, [account, server]);

  const end = (session: AccountSession) => act(session.sessionId, async () => {
    // Ending this phone's own session is signing out.
    if (session.current) return signOut();
    const device = session.client ?? accountWords.unknownDevice;
    if (!await confirm({ title: accountWords.endSessionTitle(device), message: accountWords.endSessionBody(server), confirm: accountWords.endSession, destructive: true })) return;
    await endSession(signIn.client, session.sessionId).then(
      () => sessions.update(list => list.filter(entry => entry.sessionId !== session.sessionId)),
      sessions.fail,
    );
  });

  const changeAgentStatus = (agent: PersonalAgent, change: "sign-out" | "remove" | "restore") => act(agent.agentId, async () => {
    if (change === "sign-out" && !await confirm({
      title: accountWords.signOutAgentTitle(agent.name), message: accountWords.signOutAgentBody, confirm: accountWords.signOut, destructive: true,
    })) return;
    await changeAgent(signIn.client, agent.agentId, change).then(
      status => agents.update(roster => ({ ...roster, agents: roster.agents.map(entry => entry.agentId === agent.agentId ? { ...entry, status } : entry) })),
      agents.fail,
    );
  });

  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: theme.bg }} contentContainerStyle={styles.page}>
      <Section title={accountWords.account}>
        <Row title={signIn.email} detail={server} />
      </Section>

      <Section title={accountWords.showOnPhone}>
        {workspaces.status === "failed" ? <ProblemLine text={accountWords.problem(workspaces.problem, server)} onRetry={reloadWorkspaces} /> : null}
        {workspaces.status === "ready" ? (
          <>
            {workspaces.problem ? <ProblemLine text={accountWords.problem(workspaces.problem, server)} onRetry={reloadWorkspaces} /> : null}
            {workspaces.workspaces.length === 0 ? <Empty text={accountWords.noWorkspaces(server)} /> : null}
            {workspaces.workspaces.map(workspace => {
              const name = workspaceName(workspace);
              return (
                <Row key={workspace.workspaceId} title={name}>
                  {/* Busy until the server answers its change. */}
                  <Switch value={workspace.showOnPhone} disabled={workspaces.pending.has(workspace.workspaceId)}
                    onValueChange={value => setShowOnPhone(workspace.workspaceId, value)}
                    accessibilityLabel={accountWords.showOnPhoneLabel(name)} />
                </Row>
              );
            })}
          </>
        ) : null}
      </Section>

      <Section title={accountWords.sessions}>
        <Loaded load={sessions.load} server={server} onRetry={sessions.reload}>
          {list => list.map(session => (
            <Row key={session.sessionId} title={session.current ? accountWords.thisPhone : session.client ?? accountWords.unknownDevice}
              detail={accountWords.signedInOn(new Date(session.createdAtMs).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }))}>
              <RowAction label={accountWords.endSession} destructive disabled={pending.has(session.sessionId)} onPress={() => void end(session)} />
            </Row>
          ))}
        </Loaded>
      </Section>

      <Section title={accountWords.agents}>
        <Loaded load={agents.load} server={server} onRetry={agents.reload}>
          {roster => roster.agents.length === 0 ? <Empty text={accountWords.noAgents} /> : roster.agents.map(agent => (
            <Row key={agent.agentId} lead={<AgentMark hue={agent.hue === "olive" ? undefined : agent.hue} size={32} />} title={agent.name}
              detail={`${accountWords.agentStatus[agent.status === "signed_out" ? "signedOut" : agent.status]} · ${reachOf(agent, roster)}`}>
              {agent.status === "active"
                ? <RowAction label={accountWords.signOut} destructive disabled={pending.has(agent.agentId)} onPress={() => void changeAgentStatus(agent, "sign-out")} />
                : agent.status === "signed_out"
                  ? <RowAction label={accountWords.removeAgent} destructive disabled={pending.has(agent.agentId)} onPress={() => void changeAgentStatus(agent, "remove")} />
                  // The roster doesn't list a removed agent, so Restore is here only until Settings closes.
                  : <RowAction label={accountWords.restoreAgent} disabled={pending.has(agent.agentId)} onPress={() => void changeAgentStatus(agent, "restore")} />}
            </Row>
          ))}
        </Loaded>
      </Section>

      <Section>
        <Pressable accessibilityRole="button" onPress={() => void signOut()} style={({ pressed }) => [styles.signOut, { backgroundColor: pressed ? theme.panel2 : theme.panel }]}>
          <Text style={[styles.signOutLabel, { color: theme.danger }]}>{accountWords.signOut}</Text>
        </Pressable>
      </Section>
    </ScrollView>
  );
}

function reachOf(agent: PersonalAgent, roster: PersonalRoster): string {
  return accountWords.agentReach(agent.reach.map(workspaceId => roster.workspaceNames.get(workspaceId) ?? accountWords.unnamedWorkspace));
}

// A list's place: blank while it loads, its failure with Try again, or its rows.
function Loaded<T>({ load, server, onRetry, children }: { load: Load<T>; server: string; onRetry(): void; children: (value: T) => ReactNode }) {
  if (load.status === "loading") return null;
  if (load.status === "failed") return <ProblemLine text={accountWords.problem(load.problem, server)} onRetry={onRetry} />;
  return (
    <>
      {load.problem ? <ProblemLine text={accountWords.problem(load.problem, server)} onRetry={onRetry} /> : null}
      {children(load.value)}
    </>
  );
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.section}>
      {title ? <Text style={[styles.heading, { color: theme.muted }]} accessibilityRole="header">{title}</Text> : null}
      <View>{children}</View>
    </View>
  );
}

function Row({ title, detail, lead, children }: { title: string; detail?: string; lead?: ReactNode; children?: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={[styles.row, { borderBottomColor: theme.line }]}>
      {lead}
      <View style={styles.rowText}>
        <Text style={[styles.title, { color: theme.ink }]} numberOfLines={1} ellipsizeMode="middle">{title}</Text>
        {detail ? <Text style={[styles.detail, { color: theme.muted }]}>{detail}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function RowAction({ label, onPress, destructive = false, disabled }: { label: string; onPress(): void; destructive?: boolean; disabled: boolean }) {
  const theme = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} hitSlop={8} style={styles.action}>
      <Text style={[styles.actionLabel, { color: disabled ? theme.subtle : destructive ? theme.danger : theme.ink }]}>{label}</Text>
    </Pressable>
  );
}

function Empty({ text }: { text: string }) {
  const theme = useTheme();
  return <Text style={[styles.empty, { color: theme.muted }]}>{text}</Text>;
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 16, paddingBottom: 48, gap: 32 },
  section: { gap: 8 },
  heading: { fontSize: 15, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 52, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  rowText: { flex: 1, gap: 2 },
  title: { fontSize: 17 },
  detail: { fontSize: 15, lineHeight: 20 },
  action: { minHeight: 44, justifyContent: "center" },
  actionLabel: { fontSize: 17 },
  empty: { fontSize: 15, lineHeight: 20, paddingVertical: 8 },
  signOut: { minHeight: 50, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  signOutLabel: { fontSize: 17, fontWeight: "600" },
});

export default signedInOnly(SettingsScreen);
