import type { ServerProblemKind } from "@dohc/interface-words/account";
import { noticesWords } from "@dohc/interface-words/notices";
import { workspaceWords } from "@dohc/interface-words/workspace";
import { useRouter } from "expo-router";
import { FileText, Search, X } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAccount, useSignIn } from "../account/AccountProvider";
import { pageTitle } from "../home/homeModel";
import { ActionPill } from "../notices/ActionPill";
import { requestGenerations, shownProblem } from "../server/client";
import {
  deriveSearchUiState,
  searchWorkspace,
  type MatchedSearchAnswer,
  type SearchHit,
} from "../server/search";
import { views } from "../server/workspaceData";
import { useTheme } from "../theme";
import { ripple, TOUCH } from "../touch";
import { EmptyLine, NoWorkspace, RetryRow } from "../workspace/ListStates";

export function SearchScreen() {
  const theme = useTheme();
  const router = useRouter();
  const signIn = useSignIn();
  const { data } = useAccount();
  const workspaceId = data?.workspaceId ?? null;
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [matched, setMatched] = useState<MatchedSearchAnswer | null>(null);
  const [problem, setProblem] = useState<ServerProblemKind | null>(null);
  const [generations] = useState(requestGenerations);
  const abortRef = useRef<AbortController | null>(null);

  const runSearch = useCallback(
    (raw: string) => {
      abortRef.current?.abort();
      abortRef.current = null;
      const trimmed = raw.trim();
      if (!trimmed || !data || !workspaceId) {
        generations.next();
        setLoading(false);
        setMatched(null);
        setProblem(null);
        return;
      }
      const token = generations.next();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setProblem(null);
      const stale = () =>
        controller.signal.aborted ||
        !signIn.isCurrent() ||
        !data.isOpen() ||
        !generations.isLatest(token);
      void searchWorkspace(signIn.client, workspaceId, trimmed, controller.signal).then(
        (found) => {
          if (stale()) return;
          setMatched({ workspaceId, query: trimmed, answer: found });
          setLoading(false);
          setProblem(null);
        },
        (error: unknown) => {
          if (stale()) return;
          setLoading(false);
          const next = shownProblem(error);
          if (next !== null) setProblem(next);
        },
      );
    },
    [data, generations, signIn, workspaceId],
  );

  useEffect(() => {
    setMatched(null);
    setProblem(null);
    setLoading(false);
    abortRef.current?.abort();
    generations.next();
  }, [workspaceId, data?.instance, generations]);
  useEffect(() => {
    if (!query.trim()) return runSearch("");
    const timer = setTimeout(() => runSearch(query), 200);
    return () => clearTimeout(timer);
  }, [query, runSearch]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const ui = deriveSearchUiState({ workspaceId, query, loading, matched, problem });
  const renderHits = (hits: readonly SearchHit[]) =>
    hits.map((hit) => {
      const folder = hit.path.includes("/") ? hit.path.slice(0, hit.path.lastIndexOf("/")) : "";
      const title = hit.title || pageTitle(hit.path);
      return (
        <Pressable
          key={hit.path}
          onPressIn={() => data?.prefetch(views.page(hit.path))}
          onPress={() =>
            workspaceId &&
            router.push({
              pathname: "/page",
              params: { path: hit.path, workspace: workspaceId, t0: String(Date.now()) },
            })
          }
          android_ripple={ripple(theme)}
          style={({ pressed }) => [styles.row, pressed ? { backgroundColor: theme.panel2 } : null]}
          accessibilityRole="button"
          accessibilityLabel={title}
        >
          <FileText size={18} color={theme.ink} strokeWidth={1.9} />
          <View style={styles.hitText}>
            <Text style={[styles.title, { color: theme.ink }]} numberOfLines={1}>
              {title}
            </Text>
            {folder ? (
              <Text style={[styles.meta, { color: theme.subtle }]} numberOfLines={1}>
                {folder}
              </Text>
            ) : null}
            {hit.snippet ? (
              <Text style={[styles.snippet, { color: theme.muted }]} numberOfLines={2}>
                {hit.snippet}
              </Text>
            ) : null}
          </View>
        </Pressable>
      );
    });

  return (
    <View style={[styles.screen, { backgroundColor: theme.bg }]}>
      <NoWorkspace />
      {workspaceId ? (
        <>
          <View style={[styles.bar, { borderColor: theme.line }]}>
            <View style={[styles.field, { backgroundColor: theme.panel, borderColor: theme.line }]}>
              <Search size={18} color={theme.muted} strokeWidth={1.9} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder={workspaceWords.searchPlaceholder}
                placeholderTextColor={theme.subtle}
                autoFocus
                returnKeyType="search"
                onSubmitEditing={() => runSearch(query)}
                accessibilityLabel={workspaceWords.searchPlaceholder}
                style={[styles.input, { color: theme.ink }]}
              />
              {query.length > 0 ? (
                <Pressable
                  onPress={() => setQuery("")}
                  android_ripple={ripple(theme, true)}
                  style={styles.clear}
                  accessibilityRole="button"
                  accessibilityLabel={workspaceWords.clearSearch}
                >
                  <X size={16} color={theme.muted} strokeWidth={2} />
                </Pressable>
              ) : null}
            </View>
          </View>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.list}>
            {ui.kind === "loading" ? (
              <View style={styles.stateRow}>
                <ActivityIndicator size="small" />
              </View>
            ) : null}
            {ui.kind === "error" ? (
              <RetryRow label={workspaceWords.searchFailed} onRetry={() => runSearch(query)} />
            ) : null}
            {ui.kind === "incomplete" ? (
              <RetryRow label={workspaceWords.searchIncomplete} onRetry={() => runSearch(query)} />
            ) : null}
            {ui.kind === "indexing" ? (
              <>
                <View
                  style={[styles.banner, { backgroundColor: theme.panel, borderColor: theme.line }]}
                >
                  <Text style={[styles.snippet, { color: theme.muted }]}>
                    {workspaceWords.searchIndexing}
                  </Text>
                  <ActionPill label={noticesWords.tryAgain} onPress={() => runSearch(query)} />
                </View>
                {renderHits(ui.results)}
              </>
            ) : null}
            {ui.kind === "empty" ? (
              <EmptyLine text={workspaceWords.noSearchResults(ui.query)} />
            ) : null}
            {ui.kind === "results" ? renderHits(ui.results) : null}
          </ScrollView>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  bar: { paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: TOUCH,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  input: { flex: 1, fontSize: 17, paddingVertical: 8 },
  clear: { minWidth: 32, minHeight: 32, alignItems: "center", justifyContent: "center" },
  list: { paddingBottom: 48 },
  stateRow: { padding: 24, alignItems: "center" },
  banner: {
    margin: 16,
    padding: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
    alignItems: "flex-start",
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    minHeight: TOUCH,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  hitText: { flex: 1, gap: 2 },
  title: { fontSize: 17, lineHeight: 22 },
  meta: { fontSize: 13, lineHeight: 18 },
  snippet: { fontSize: 15, lineHeight: 20 },
});
