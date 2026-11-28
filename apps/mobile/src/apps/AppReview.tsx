import { appWords } from "@dohc/interface-words/apps";
import { sharingWords } from "@dohc/interface-words/sharing";
import type { ServerProblemKind } from "@dohc/interface-words/account";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ChevronRight, FileCode, ShieldCheck, ShieldQuestion } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import type { AppRunner, WorkspaceApps } from "./appStore";
import { canOpenApps } from "./canOpenApps";
import { reviewControls, reviewStatus } from "./reviewControls";

// An app's review, from Home: its version, who published or made it, what it can reach, its declared source, and
// Approve, Open and Revoke. A Member app lists only what both its author and the person can do, and Allow and open
// allows exactly that. Approve, Allow and Open need phone writes (canOpenApps.ts). Revoke shows on every phone, as
// an account-wide approval's way back. Answers land only while their request is the latest and their sign-in and
// workspace are still open. Errors show in place, as on any screen outside the tabs.

let publishedOffset = Number.NaN;
let publishedDate: Intl.DateTimeFormat;
const publishedOn = (ms: number) => {
  const offset = new Date().getTimezoneOffset();
  if (offset !== publishedOffset) {
    publishedOffset = offset;
    publishedDate = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
  return publishedDate.format(ms);
};
export function AppReviewScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { apps, runner } = useAccount();
  if (!apps || !id) return <ScreenFailure text={appWords.reviewFailed} />;
  return (
    <Review key={`${apps.workspaceId}:${id}`} apps={apps} runner={runner} publicationId={id} />
  );
}

type Loaded<T> = {
  readonly value: T | null;
  readonly problem: ServerProblemKind | null;
  readonly fresh: boolean;
};

/** Reads whose answers replace each other, landing only while `apps` is live. */
function useLatest<T>(
  apps: WorkspaceApps,
  read: () => Promise<T>,
  initial: T | null = null,
  clearOnDenied = false,
) {
  const [state, setState] = useState<Loaded<T>>(() => ({
    value: initial,
    problem: null,
    fresh: false,
  }));
  const reads = useRef(requestGenerations());
  const loading = useRef(false);
  const load = useCallback(() => {
    const request = reads.current.next();
    loading.current = true;
    const lands = () => apps.isLive() && reads.current.isLatest(request);
    read().then(
      (value) => {
        if (!lands()) return;
        loading.current = false;
        setState({ value, problem: null, fresh: true });
      },
      (error: unknown) => {
        const problem = shownProblem(error);
        if (!lands()) return;
        loading.current = false;
        if (problem === null) return;
        const drop = clearOnDenied && problem === "refused";
        setState((previous) => ({
          value: drop ? null : previous.value,
          problem,
          fresh: drop ? false : previous.fresh,
        }));
      },
    );
  }, [apps, read, clearOnDenied]);
  const invalidate = useCallback(() => {
    setState((previous) => (previous.fresh ? { ...previous, fresh: false } : previous));
  }, []);
  return { state, load, loading, invalidate };
}

function Review({
  apps,
  runner,
  publicationId,
}: {
  apps: WorkspaceApps;
  runner: AppRunner;
  publicationId: string;
}) {
  const theme = useTheme();
  const router = useRouter();
  const problemText = useProblemText();
  const read = useCallback(() => apps.readReview(publicationId), [apps, publicationId]);
  const [initial] = useState(() => apps.cachedReview(publicationId));
  const { state, load, invalidate } = useLatest(apps, read, initial, true);
  useEffect(load, [load]);
  // Leaving the review ends a launch still on its way, and its move to the runner.
  const [leaving] = useState(() => new AbortController());
  useEffect(() => () => leaving.abort(), [leaving]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ text: string; retry(): void } | null>(null);
  const listed = useSyncExternalStore(apps.subscribe, apps.state).apps?.find(
    (app) => app.publicationId === publicationId,
  );
  const review = state.value;
  const waiting = busy || !state.fresh;
  const name = review ? appName(review) : listed ? appName(listed) : "";

  // One action at a time. Its failure's Try again repeats it; a changed app's reads the review again.
  const act = async (failed: string, run: (app: AppReview) => Promise<unknown>, mutates = true) => {
    if (busy || !state.fresh || !review) return;
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
            : {
                text: `${failed} ${problemText(problem)}`,
                retry: () => void actRef.current(failed, run, mutates),
              },
        );
    } finally {
      if (here()) {
        setBusy(false);
        if (mutates) invalidate();
        load();
      }
    }
  };
  const actRef = useRef(act);
  actRef.current = act;
  const launch = (app: AppReview) => {
    const opening = apps.open({ ...app, name }, leaving.signal);
    if (!leaving.signal.aborted && apps.isLive()) router.push("/app-run");
    return opening;
  };
  const approve = () =>
    review?.member
      ? act(appWords.allowFailed, async (app) => {
          await apps.approve(app);
          if (canOpenApps) await launch(app);
        })
      : act(appWords.approveFailed, (app) => apps.approve(app));
  const open = () => act(appWords.openFailed, launch, false);
  // This app's web process died while it ran: the runner's screen has left, and Try again opens it again. The runner
  // forgets it when its sign-in or workspace ends.
  const stopped = useSyncExternalStore(runner.subscribe, runner.stopped);
  const stoppedHere =
    stopped?.publicationId === publicationId && stopped.workspaceId === apps.workspaceId;
  const revoke = async () => {
    if (
      await confirm({
        title: appWords.revokeTitle(name),
        message: review?.member ? appWords.memberRevokeBody : appWords.revokeBody,
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
      <>
        {name ? <Stack.Screen options={{ title: name }} /> : null}
        <HoldRow />
      </>
    );
  const Mark = review.approved ? ShieldCheck : ShieldQuestion;
  const controls = reviewControls(review, { phoneWrites, canOpen: canOpenApps });
  const { member } = review;
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
        <Text style={[styles.body, { color: theme.ink }]}>{reviewStatus(review, phoneWrites)}</Text>
      </View>
      {member ? (
        <Text style={[styles.note, { color: theme.muted }]}>
          {member.author ? appWords.sharedBy(member.author) : appWords.sharedByMember}
        </Text>
      ) : null}
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
      {controls.open ? <Button label={appWords.open} onPress={open} disabled={waiting} /> : null}
      {controls.approve ? (
        <Button label={controls.approve} onPress={approve} disabled={waiting} />
      ) : null}
      {controls.revoke ? (
        <View style={styles.row}>
          <ActionPill
            label={appWords.revoke}
            onPress={revoke}
            busy={busy}
            disabled={!state.fresh}
          />
        </View>
      ) : null}
      {failure ? (
        <ProblemLine text={failure.text} onRetry={failure.retry} />
      ) : stoppedHere ? (
        <ProblemLine text={appWords.stopped} onRetry={open} />
      ) : null}

      <Text style={[styles.heading, { color: theme.ink }]} accessibilityRole="header">
        {appWords.reach}
      </Text>
      {member ? (
        <Text style={[styles.note, { color: theme.muted }]}>{appWords.memberNote}</Text>
      ) : null}
      {review.reach.length === 0 ? (
        <Text style={[styles.body, { color: theme.ink }]}>{appWords.reachesNothing}</Text>
      ) : null}
      {review.reach.map((collection) => (
        <View key={collection.datasetId} style={styles.group}>
          <Text style={[styles.body, styles.strong, { color: theme.ink }]}>
            {collection.name}
            {collection.alias ? (
              <Text style={[styles.alias, { color: theme.muted }]}> {collection.alias}</Text>
            ) : null}
          </Text>
          {collection.access ? (
            <Text style={[styles.note, { color: theme.muted }]}>
              {appWords.access(sharingWords.level[collection.access])}
            </Text>
          ) : null}
          {collection.operations.map((operation) => (
            <View key={operation.name} accessible>
              <Text style={[styles.body, { color: theme.ink }]}>{operation.name}</Text>
              <Text style={[styles.note, { color: theme.muted }]}>
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
  const { state, load, loading } = useLatest<AppSource>(apps, read);
  const prefetch = () => {
    if (!open && !state.value && !loading.current) load();
  };
  const toggle = () => {
    prefetch();
    setOpen(!open);
  };
  return (
    <View>
      <Pressable
        onPressIn={prefetch}
        onPress={toggle}
        android_ripple={{ color: theme.panel2 }}
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
  alias: { fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }), fontSize: 13 },
  mono: {
    fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
    fontSize: 13,
    lineHeight: 18,
  },
});
