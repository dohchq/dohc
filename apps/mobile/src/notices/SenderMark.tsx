import { noticesWords } from "@dohc/interface-words/notices";
import { AlertTriangle, Sparkles, User, Zap } from "lucide-react-native";
import { StyleSheet, View } from "react-native";
import { useTheme } from "../theme";
import type { SenderKind } from "./sample";

// The sender's shape, as on the desktop and in chat: round for a person, a rounded square for an agent,
// the bare lightning mark for an automation. A failure takes the danger triangle in place of its sender's shape,
// as the desktop marks a failed notice; a failure held on this phone has no sender. Shape is visual only; the
// screen reader hears who sent it.
export function SenderMark({ kind, failed = false }: { kind: SenderKind | null; failed?: boolean }) {
  const theme = useTheme();
  const triangle = <AlertTriangle size={18} color={theme.danger} strokeWidth={2} />;
  if (kind === null) return <View style={styles.box}>{triangle}</View>;
  const label = noticesWords.fromSender[kind];
  if (failed) return <View style={styles.box} accessible accessibilityLabel={label}>{triangle}</View>;
  if (kind === "automation") {
    return <View style={styles.box} accessible accessibilityLabel={label}><Zap size={18} color={theme.muted} strokeWidth={2} /></View>;
  }
  return (
    <View accessible accessibilityLabel={label} style={[styles.box, styles.edge, kind === "person"
      ? { backgroundColor: theme.panel2, borderColor: theme.line, borderRadius: 15 }
      : { backgroundColor: theme.bg, borderColor: theme.agentLine, borderRadius: 8 }]}>
      {kind === "person" ? <User size={16} color={theme.muted} strokeWidth={2} /> : <Sparkles size={16} color={theme.agent} strokeWidth={2} />}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  edge: { borderWidth: 1 },
});
