import { documentWords } from "@dohc/interface-words/documents";
import { AlertTriangle, Lock, LoaderCircle } from "lucide-react-native";
import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { ActionPill } from "../notices/ActionPill";
import type { Theme } from "../theme";

// What the sample's page and the server's draw alike: the state mark, the loading lines, and a strip over the text.

export type MarkKey = keyof typeof documentWords.mark | "opening";
type MarkShape = "held" | "attention" | "working";

export function labelOf(key: MarkKey): string { return key === "opening" ? documentWords.opening : documentWords.mark[key].label; }
export function explanationOf(key: MarkKey): string { return key === "opening" ? documentWords.openingExplanation : documentWords.mark[key].explanation; }
function shapeOf(key: MarkKey): MarkShape { return key === "opening" ? "working" : key === "deleted" || key === "couldntSave" ? "attention" : "held"; }

// The desktop's StateMark: a lock for held, a triangle for attention, a ring for working; the label beside it.
export function Mark({ markKey, theme }: { markKey: MarkKey; theme: Theme }) {
  const shape = shapeOf(markKey);
  const color = shape === "attention" ? theme.danger : theme.muted;
  const icon: ReactNode = shape === "held" ? <Lock size={11} color={color} strokeWidth={2.5} />
    : shape === "attention" ? <AlertTriangle size={11} color={color} strokeWidth={2.5} />
    : <LoaderCircle size={11} color={color} strokeWidth={2.5} />;
  return (
    <View style={pageStyles.mark}>
      {icon}
      <Text style={[pageStyles.markText, { color }]}>{labelOf(markKey)}</Text>
    </View>
  );
}

// The desktop's document loading lines (ui/SkeletonRows.tsx, layout "document"): nothing for 150 ms, so a fast
// open never flashes; then one 120 ms fade, none under Reduce Motion. Static, four lines where the text will land.
export function LoadingLines({ theme, reduceMotion }: { theme: Theme; reduceMotion: boolean }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), 150);
    return () => clearTimeout(timer);
  }, []);
  return (
    <View style={[pageStyles.loading, { backgroundColor: theme.bg }]} accessible accessibilityLabel={documentWords.loading}>
      {shown ? (
        <Animated.View entering={reduceMotion ? undefined : FadeIn.duration(120)} style={pageStyles.loadingLines}>
          {[0.8, 0.62, 0.9, 0.54].map((width, index) => (
            <View key={index} style={[pageStyles.loadingLine, { width: `${width * 100}%`, backgroundColor: inkAt(theme.ink, 0.07) }]} />
          ))}
        </Animated.View>
      ) : null}
    </View>
  );
}

function inkAt(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

// A notice across the top of the page, as the desktop's strip above a document.
// A held page takes the lock in warning; a failed read, the triangle in danger.
export function Strip({ theme, icon, text, action, onAction }: { theme: Theme; icon: "lock" | "failed"; text: string; action?: string; onAction?(): void }) {
  const color = icon === "lock" ? theme.warning : theme.danger;
  return (
    <View style={[pageStyles.strip, { backgroundColor: theme.panel2, borderBottomColor: theme.line }]}>
      <View style={pageStyles.stripIcon}>{icon === "lock" ? <Lock size={16} color={color} strokeWidth={2} /> : <AlertTriangle size={16} color={color} strokeWidth={2} />}</View>
      <View style={pageStyles.stripMain}>
        <Text style={[pageStyles.stripText, { color }]}>{text}</Text>
        {action ? <View style={pageStyles.stripActions}><ActionPill label={action} onPress={onAction} /></View> : null}
      </View>
    </View>
  );
}

export const pageStyles = StyleSheet.create({
  screen: { flex: 1 },
  web: { flex: 1 },
  // Where the page's text lands: the web view's 16 pt inset, under the icon's top margin.
  loading: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, paddingHorizontal: 16, paddingTop: 24 },
  loadingLines: { gap: 9 },
  loadingLine: { height: 8, borderRadius: 4 },
  failure: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 32, paddingBottom: 80 },
  failureText: { fontSize: 15, lineHeight: 20, textAlign: "center" },
  headerTitle: { alignItems: "center", maxWidth: 220 },
  titleTarget: { minHeight: 44, justifyContent: "center", paddingHorizontal: 8 },
  name: { fontSize: 17, fontWeight: "600" },
  mark: { flexDirection: "row", alignItems: "center", gap: 4 },
  markText: { fontSize: 12, fontWeight: "500" },
  popover: { position: "absolute", alignSelf: "center", left: 40, right: 40, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 12,
    shadowColor: "#000", shadowOpacity: 0.14, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } },
  popoverText: { fontSize: 15, lineHeight: 20 },
  strip: { flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  stripIcon: { paddingTop: 2 },
  stripMain: { flex: 1, gap: 8 },
  stripText: { fontSize: 15, lineHeight: 20 },
  stripActions: { flexDirection: "row" },
});
