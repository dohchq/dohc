import { appWords } from "@dohc/interface-words/apps";
import type { ServerProblemKind } from "@dohc/interface-words/account";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ChevronRight, FileCode, ShieldCheck, ShieldQuestion } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAccount } from "../account/AccountProvider";
import { Button } from "../account/Button";
import { ProblemLine } from "../account/ProblemLine";
import { confirm } from "../confirm";
import { ActionPill } from "../notices/ActionPill";
import { requestGenerations, ServerError, shownProblem } from "../server/client";
import { appName, shortVersion, type AppReview, type AppSource } from "../server/phoneApps";
import { phoneWrites } from "../server/phoneWrites";
import { useTheme } from "../theme";
import { HoldRow, ScreenFailure } from "../workspace/ListStates";
import { useProblemText } from "../workspace/useView";
import type { WorkspaceApps } from "./appStore";
import { canOpenApps } from "./canOpenApps";

// An app's review, from Home: its version, who published it, what it can reach, its declared source, and Approve, Open
// and Revoke. Approve and Open need phone writes (canOpenApps.ts). Revoke shows on every phone, as
// an account-wide approval's way back. Answers land only while their request is the latest and their sign-in and
// workspace are still open. Errors show in place, as on any screen outside the tabs.

const publishedOn = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
export function AppReviewScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { apps } = useAccount();
  if (!apps || !id) return <ScreenFailure text={appWords.reviewFailed} />;
  return <Review key={`${apps.workspaceId}:${id}`} apps={apps} publicationId={id} />;
}

type Loaded<T> = { readonly value: T | null; readonly problem: ServerProblemKind | null };

/** Reads whose answers replace each other, landing only while `apps` is live. */
function useLatest<T>(apps: WorkspaceApps, read: () => Promise<T>) {
  const [state, setState] = useState<Loaded<T>>({ value: null, problem: null });
  const reads = useRef(requestGenerations());
  const load = useCallback(() => {
    const request = reads.current.next();
    const lands = () => apps.isLive() && reads.current.isLatest(request);
    read().then(
      (value) => lands() && setState({ value, problem: null }),
      (error: unknown) => {
        const problem = shownProblem(error);
        if (lands() && problem !== null) setState((previous) => ({ ...previous, problem }));
      },
    );
  }, [apps, read]);
  return { state, load };
}

function Review({ apps, publicationId }: { apps: WorkspaceApps; publicationId: string }) {
  const theme = useTheme();
  const router = useRouter();
  const problemText = useProblemText();
  const read = useCallback(() => apps.operations.review(publicationId), [apps, publicationId]);
  const { state, load } = useLatest(apps, read);
  useEffect(load, [load]);
  // Leaving the review ends a launch still on its way, and its move to the runner.
  const [leaving] = useState(() => new AbortController());
  useEffect(() => () => leaving.abort(), [leaving]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ text: string; retry(): void } | null>(null);
  const review = state.value;
  const name = review ? appName(review) : "";

  // One action at a time. Its failure's Try again repeats it; a changed app's reads the review again.
  const act = async (failed: string, run: (app: AppReview) => Promise<unknown>) => {
    if (busy || !review) return;
    setBusy(true);
    setFailure(null);
    const here = () => !leaving.signal.aborted && apps.isLive();
    try {
      await run(review);
    } catch (error) {
      const problem = shownProblem(error);
      if (here() && problem !== null)
        setFailure(
          error instanceof ServerError && error.code === "conflict"
            ? {
                text: appWords.changed,
                retry: () => {
                  setFailure(null);
                  load();
                },
              }
            : { text: `${failed} ${problemText(problem)}`, retry: () => void act(failed, run) },
        );
    } finally {
      if (here()) {
        setBusy(false);
        load();
      }
    }
  };
  const approve = () => act(appWords.approveFailed, (app) => apps.approve(app));
  const open = () =>
    act(appWords.openFailed, async (app) => {
      if (await apps.open({ ...app, name }, leaving.signal)) router.push("/app-run");
    });
  const revoke = async () => {
    if (
      await confirm({
        title: appWords.revokeTitle(name),
        message: appWords.revokeBody,
        confirm: appWords.revoke,
        destructive: true,
      })
    )
      void act(appWords.revokeFailed, (app) => apps.revoke(app.publicationId));
  };

  if (!review)
    return state.problem ? (
      <ScreenFailure
        text={appWords.reviewFailed}
        cause={problemText(state.problem)}
        onRetry={load}
      />
    ) : (
      <HoldRow />
    );
  const Mark = review.approved ? ShieldCheck : ShieldQuestion;
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: name }} />
      {state.problem ? (
        <ProblemLine
          text={`${appWords.reviewFailed} ${problemText(state.problem)}`}
          onRetry={load}
        />
      ) : null}
      <View style={styles.status}>
        <Mark size={20} color={review.approved ? theme.accent : theme.muted} strokeWidth={1.9} />
        <Text style={[styles.body, { color: theme.ink }]}>
          {review.approved
            ? appWords.approvedOnPhones
            : phoneWrites
              ? appWords.approveToOpen
              : appWords.notApproved}
        </Text>
      </View>
      <Text style={[styles.note, { color: theme.muted }]}>
        {appWords.published(shortVersion(review), publishedOn(review.createdAtMs))}
      </Text>
      {review.agent ? (
        <Text style={[styles.note, { color: theme.muted }]}>
          {review.agent.label
            ? appWords.publishedBy(review.agent.label)
            : appWords.publishedByAgent}
        </Text>
      ) : null}
      {canOpenApps ? null : (
        <Text style={[styles.note, { color: theme.muted }]}>{appWords.cantOpenHere}</Text>
      )}
      {review.approved && canOpenApps ? (
        <Button label={appWords.open} onPress={open} disabled={busy} />
      ) : null}
      {!review.approved && phoneWrites ? (
        <Button label={appWords.approve} onPress={approve} disabled={busy} />
      ) : null}
      {review.approved ? (
        <View style={styles.row}>
          <ActionPill label={appWords.revoke} onPress={revoke} busy={busy} />
        </View>
      ) : null}
      {failure ? <ProblemLine text={failure.text} onRetry={failure.retry} /> : null}

      <Text style={[styles.heading, { color: theme.ink }]} accessibilityRole="header">
        {appWords.reach}
      </Text>
      {review.reach.length === 0 ? (
        <Text style={[styles.body, { color: theme.ink }]}>{appWords.reachesNothing}</Text>
      ) : null}
      {review.reach.map((collection) => (
        <View key={collection.name} style={styles.group}>
          <Text style={[styles.body, styles.strong, { color: theme.ink }]}>{collection.name}</Text>
          {collection.operations.map((operation) => (
            <View key={operation.name} accessible>
              <Text style={[styles.body, { color: theme.ink }]}>
                {operation.readOnly ? appWords.readsRecords : appWords.changesRecords}
              </Text>
              {operation.fields.length > 0 ? (
                <Text style={[styles.note, { color: theme.muted }]}>
                  {appWords.fields(operation.fields.join(", "))}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ))}
      <Text style={[styles.note, { color: theme.muted }]}>{appWords.sendsElsewhere}</Text>

      <Text style={[styles.heading, { color: theme.ink }]} accessibilityRole="header">
        {appWords.source}
      </Text>
      <Text style={[styles.note, { color: theme.muted }]}>{appWords.sourceNote}</Text>
      {review.sources.map((path) => (
        <SourceFile key={path} apps={apps} publicationId={publicationId} path={path} />
      ))}
    </ScrollView>
  );
}

/** One declared source file, read as plain text when opened. Never run, and never shown in a web view. */
function SourceFile(props: { apps: WorkspaceApps; publicationId: string; path: string }) {
  const { apps, publicationId, path } = props;
  const theme = useTheme();
  const problemText = useProblemText();
  const [open, setOpen] = useState(false);
  const read = useCallback(
    () => apps.operations.source(publicationId, path),
    [apps, publicationId, path],
  );
  const { state, load } = useLatest<AppSource>(apps, read);
  const toggle = () => {
    if (!open && !state.value) load();
    setOpen(!open);
  };
  return (
    <View>
      <Pressable
        onPress={toggle}
        style={styles.file}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={path}
      >
        <FileCode size={18} color={theme.ink} strokeWidth={1.9} />
        <Text style={[styles.path, { color: theme.ink }]} numberOfLines={2}>
          {path}
        </Text>
        <ChevronRight
          size={16}
          color={theme.muted}
          strokeWidth={2}
          style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}
        />
      </Pressable>
      {!open ? null : state.value?.available ? (
        <ScrollView horizontal style={[styles.code, { backgroundColor: theme.panel2 }]}>
          <Text selectable style={[styles.mono, { color: theme.ink }]}>
            {state.value.text}
          </Text>
        </ScrollView>
      ) : state.value ? (
        <Text style={[styles.note, { color: theme.muted }]}>{appWords.sourceUnavailable}</Text>
      ) : state.problem ? (
        <ProblemLine
          text={`${appWords.sourceFailed} ${problemText(state.problem)}`}
          onRetry={load}
        />
      ) : (
        <HoldRow />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: 12, padding: 16, paddingBottom: 120 },
  status: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 },
  row: { flexDirection: "row" },
  heading: { fontSize: 20, fontWeight: "600", marginTop: 16 },
  group: { gap: 6 },
  body: { flexShrink: 1, fontSize: 17, lineHeight: 22 },
  strong: { fontWeight: "600" },
  note: { fontSize: 15, lineHeight: 20 },
  file: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44 },
  path: { flex: 1, fontSize: 17 },
  code: { borderRadius: 8, padding: 12 },
  mono: {
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: 13,
    lineHeight: 18,
  },
});
