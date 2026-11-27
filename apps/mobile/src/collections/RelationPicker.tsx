import { collectionWords } from "@dohc/interface-words/collections";
import * as Haptics from "expo-haptics";
import { Check, Search, X } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { ProblemLine } from "../account/ProblemLine";
import { shownProblem } from "../server/client";
import type {
  RecordCursor,
  RecordId,
  RelationOption,
  RelationOptionsPage,
} from "../server/phoneCollections";
import type { ReadProblem } from "../server/workspaceData";
import { useTheme } from "../theme";
import { ripple, slopTo, TOUCH } from "../touch";
import { EmptyLine, HoldRow } from "../workspace/ListStates";
import { useProblemText } from "../workspace/useView";

export interface RelationPickerProps {
  readonly name: string;
  readonly many: boolean;
  readonly selected: readonly RecordId[];
  readonly labels: Readonly<Record<string, string>>;
  readonly load: (
    search: string,
    after: RecordCursor | null,
    signal: AbortSignal,
  ) => Promise<RelationOptionsPage>;
  readonly onChange: (next: readonly RecordId[], labels: Readonly<Record<string, string>>) => void;
}

export function RelationPicker(props: RelationPickerProps) {
  const { name, many, selected, labels, load, onChange } = props;
  const theme = useTheme();
  const problemText = useProblemText();
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<readonly RelationOption[]>([]);
  const [next, setNext] = useState<RecordCursor | null>(null);
  const [reading, setReading] = useState<"first" | "more" | null>("first");
  const [problem, setProblem] = useState<ReadProblem | null>(null);
  const [searchUnsupported, setSearchUnsupported] = useState(false);
  const [limitError, setLimitError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const known = useRef<Record<string, string>>({ ...labels });
  useEffect(() => {
    Object.assign(known.current, labels);
  }, [labels]);

  const fetchPage = useCallback(
    async (term: string, after: RecordCursor | null) => {
      abortRef.current?.abort();
      const abort = new AbortController();
      abortRef.current = abort;
      setReading(after ? "more" : "first");
      setProblem(null);
      try {
        const page = await load(term, after, abort.signal);
        if (abortRef.current !== abort || abort.signal.aborted) return;
        for (const opt of page.options) known.current[JSON.stringify(opt.value)] = opt.label;
        setOptions((cur) => {
          if (!after) return page.options;
          const seen = new Set(cur.map((item) => JSON.stringify(item.value)));
          return [...cur, ...page.options.filter((item) => !seen.has(JSON.stringify(item.value)))];
        });
        setNext(page.next);
        setSearchUnsupported(page.searchUnsupported);
        setReading(null);
      } catch (error) {
        const cause = shownProblem(error);
        if (abortRef.current !== abort || abort.signal.aborted || cause === null) return;
        setProblem(cause);
        setReading(null);
      }
    },
    [load],
  );
  useEffect(() => {
    const timer = setTimeout(() => void fetchPage(search.trim(), null), search ? 200 : 0);
    return () => clearTimeout(timer);
  }, [search, fetchPage]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const pickedKeys = new Set(selected.map((item) => JSON.stringify(item)));
  const toggle = (value: RecordId, label?: string) => {
    const key = JSON.stringify(value);
    if (label) known.current[key] = label;
    const on = pickedKeys.has(key);
    if (!on && many && selected.length >= 100) {
      setLimitError(collectionWords.tooManyRelations);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    setLimitError(null);
    void Haptics.selectionAsync();
    const updated = on
      ? selected.filter((item) => JSON.stringify(item) !== key)
      : many
        ? [...selected, value]
        : [value];
    const pickedLabels: Record<string, string> = {};
    for (const item of updated) {
      const k = JSON.stringify(item);
      if (Object.hasOwn(known.current, k)) pickedLabels[k] = known.current[k]!;
    }
    onChange(updated, pickedLabels);
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={[styles.searchBar, { backgroundColor: theme.field }]}>
        <Search size={18} color={theme.subtle} strokeWidth={2} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder={collectionWords.searchField(name)}
          placeholderTextColor={theme.subtle}
          returnKeyType="search"
          onSubmitEditing={() => void fetchPage(search.trim(), null)}
          maxLength={200}
          accessibilityLabel={collectionWords.searchField(name)}
          style={[styles.searchInput, { color: theme.ink }]}
        />
        {search ? (
          <Pressable
            onPress={() => setSearch("")}
            android_ripple={ripple(theme, true)}
            style={styles.iconBtn}
            accessibilityRole="button"
            accessibilityLabel={collectionWords.clearSearch}
          >
            <X size={18} color={theme.subtle} strokeWidth={2} />
          </Pressable>
        ) : null}
      </View>
      <FlatList
        data={options}
        keyExtractor={(item) => JSON.stringify(item.value)}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <>
            {selected.length > 0 ? (
              <View style={styles.selected}>
                {selected.map((item) => {
                  const key = JSON.stringify(item);
                  const label = known.current[key] ?? String(item);
                  return (
                    <Pressable
                      key={key}
                      onPress={() => toggle(item)}
                      hitSlop={slopTo(36)}
                      android_ripple={ripple(theme)}
                      style={[
                        styles.chip,
                        { backgroundColor: theme.panel2, borderColor: theme.line },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={`${collectionWords.remove} ${label}`}
                    >
                      <Text style={[styles.chipText, { color: theme.ink }]} numberOfLines={1}>
                        {label}
                      </Text>
                      <X size={15} color={theme.muted} strokeWidth={2} />
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
            {limitError ? (
              <Text style={[styles.error, { color: theme.danger }]} accessibilityRole="alert">
                {limitError}
              </Text>
            ) : null}
            {problem ? (
              <View style={styles.pad}>
                <ProblemLine
                  text={`${collectionWords.findFailed(name)} ${problemText(problem)}`}
                  onRetry={() => void fetchPage(search.trim(), null)}
                />
              </View>
            ) : null}
          </>
        }
        renderItem={({ item }) => {
          const on = pickedKeys.has(JSON.stringify(item.value));
          return (
            <Pressable
              onPress={() => toggle(item.value, item.label)}
              android_ripple={ripple(theme)}
              style={({ pressed }) => [
                styles.row,
                { borderColor: theme.line },
                pressed && { backgroundColor: theme.panel2 },
              ]}
              accessibilityRole={many ? "checkbox" : "radio"}
              accessibilityState={many ? { checked: on } : { selected: on }}
            >
              <Text style={[styles.rowText, { color: theme.ink }]} numberOfLines={2}>
                {item.label}
              </Text>
              {on ? <Check size={20} color={theme.accent} strokeWidth={2} /> : null}
            </Pressable>
          );
        }}
        ListEmptyComponent={
          reading === "first" ? (
            <HoldRow />
          ) : problem ? undefined : searchUnsupported ? (
            <EmptyLine text={collectionWords.searchUnsupported} />
          ) : (
            <EmptyLine
              text={search.trim() ? collectionWords.noMatches : collectionWords.noRecords}
            />
          )
        }
        ListFooterComponent={reading === "more" ? <HoldRow /> : undefined}
        onEndReached={() => {
          if (next && reading === null) void fetchPage(search.trim(), next);
        }}
        onEndReachedThreshold={0.5}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginVertical: 8,
    paddingLeft: 12,
    paddingRight: 4,
    borderRadius: 10,
    minHeight: TOUCH,
  },
  searchInput: { flex: 1, fontSize: 17, paddingVertical: 8 },
  iconBtn: { minHeight: TOUCH, minWidth: TOUCH, alignItems: "center", justifyContent: "center" },
  selected: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    maxWidth: "100%",
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: { fontSize: 15, flexShrink: 1 },
  error: { fontSize: 14, paddingHorizontal: 16, paddingBottom: 8 },
  pad: { paddingHorizontal: 16 },
  row: {
    minHeight: TOUCH,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowText: { fontSize: 17, flex: 1 },
});
