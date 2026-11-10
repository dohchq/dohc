import { Stack } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, StyleSheet, Text, View, useColorScheme } from "react-native";
import { runProbes, type ProbeResult } from "../src/probes";
import { msSinceStartup } from "../src/startup";
import { sampleOnly } from "../src/sampleOnly";

// Phase 0 only: shows whether each shared package works on this phone.
function ProbeScreen() {
  const [results, setResults] = useState<ProbeResult[] | null>(null);
  // undefined until measured; null when the platform has no startup time.
  const [startupMs, setStartupMs] = useState<number | null | undefined>(undefined);
  const dark = useColorScheme() === "dark";
  const ink = dark ? "#ece8e1" : "#1f1d1a";
  const muted = dark ? "#a39d94" : "#6b665e";

  useEffect(() => {
    let live = true;
    void runProbes().then(next => { if (live) setResults(next); });
    return () => { live = false; };
  }, []);

  // Measure on the first frame that shows the results.
  useEffect(() => {
    if (!results || startupMs !== undefined) return;
    const frame = requestAnimationFrame(() => setStartupMs(msSinceStartup()));
    return () => cancelAnimationFrame(frame);
  }, [results, startupMs]);

  return (
    <View style={[styles.screen, { backgroundColor: dark ? "#1a1917" : "#faf8f4" }]}>
      <Stack.Screen options={{ title: "dohc checks" }} />
      <FlatList
        data={results ?? []}
        keyExtractor={item => item.name}
        contentInsetAdjustmentBehavior="automatic"
        ListFooterComponent={startupMs !== undefined ? (
          <View>
            <Text style={[styles.footer, { color: muted }]} selectable>
              {startupMs === null ? "Start time not recorded" : `Start to content ${startupMs.toFixed(0)} ms`}
            </Text>
          </View>
        ) : undefined}
        renderItem={({ item }) => (
          <View style={styles.row} accessible accessibilityLabel={`${item.name}, ${item.ok ? "passed" : "failed"}`}>
            <Text style={[styles.mark, { color: item.ok ? "#2f7d4f" : "#b3261e" }]}>{item.ok ? "✓" : "✕"}</Text>
            <View style={styles.body}>
              <Text style={[styles.name, { color: ink }]}>{item.name}</Text>
              <Text style={[styles.detail, { color: muted }]} selectable>{item.detail} · {item.ms.toFixed(1)} ms</Text>
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  row: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  mark: { fontSize: 17, width: 20 },
  body: { flex: 1, gap: 4 },
  name: { fontSize: 15, fontWeight: "600" },
  detail: { fontSize: 13 },
  footer: { fontSize: 13, paddingHorizontal: 48, paddingVertical: 16 },
});

export default sampleOnly(ProbeScreen);
