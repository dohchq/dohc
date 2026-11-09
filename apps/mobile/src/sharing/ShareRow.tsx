import { sharingWords, type ShareStatus } from "@dohc/interface-words/sharing";
import { Check, Ellipsis, File, FileText, Folder, Layers, MessageSquare, TriangleAlert, type LucideIcon } from "lucide-react-native";
import { memo, useState } from "react";
import { Pressable, StyleSheet, Text, View, type AccessibilityActionEvent } from "react-native";
import { useAccessibilityTextSize, useLineClamp } from "../textScale";
import { useTheme, type Theme } from "../theme";
import type { SamplePerson } from "./sample";

const KIND: Record<string, LucideIcon> = { file: FileText, folder: Folder, version: Layers, chat: MessageSquare };

export interface ShareRowAction {
  readonly name: string;
  readonly label: string;
  readonly destructive?: boolean;
}

// One share, as on the desktop: what it covers, then a second line with its status, if it isn't live, and who
// can do what. VoiceOver reads it as one element: name, who, status. A row with actions opens them in a sheet
// on tap; VoiceOver has the same actions in the rotor. At accessibility text sizes the text takes the row's width and
// the faces and ellipsis move to a line under it, as Notices' controls do.
export const ShareRow = memo(function ShareRow({ kind, name, who, spokenWho, status, people, actions, onAction, copied = false }: {
  kind: string; name: string; who: string | null; spokenWho?: string; status: ShareStatus | null; people: readonly SamplePerson[];
  actions: readonly ShareRowAction[]; onAction(name: string | null): void;
  /** Just copied from its sheet: a check stands in for the ellipsis for a moment. */
  copied?: boolean;
}) {
  const theme = useTheme();
  const roomy = useAccessibilityTextSize();
  const nameLines = useLineClamp(1);
  const [pressed, setPressed] = useState(false);
  const damaged = status === "damaged";
  const Glyph = damaged ? TriangleAlert : KIND[kind] ?? File;
  const label = [name, spokenWho ?? who, status ? sharingWords.status[status] : null].filter(Boolean).join(", ");
  const has = actions.length > 0;
  return (
    <Pressable disabled={!has} onPress={() => onAction(null)} onPressIn={() => setPressed(true)} onPressOut={() => setPressed(false)}
      style={[styles.row, roomy && styles.roomyRow, pressed && { backgroundColor: theme.panel2 }]}
      accessible accessibilityRole={has ? "button" : undefined} accessibilityLabel={label} accessibilityHint={has ? sharingWords.shareActions : undefined}
      accessibilityActions={actions} onAccessibilityAction={(event: AccessibilityActionEvent) => onAction(event.nativeEvent.actionName)}>
      <View style={styles.lead}><Glyph size={20} color={damaged ? theme.danger : theme.subtle} strokeWidth={1.75} /></View>
      <View style={styles.text}>
        <Text numberOfLines={nameLines} style={[styles.name, { color: status ? theme.muted : theme.ink }]}>{name}</Text>
        {who || status ? (
          <View style={styles.second}>
            {status ? <StatusPill status={status} theme={theme} /> : null}
            {who ? <Text style={[styles.who, { color: theme.muted }]}>{who}</Text> : null}
          </View>
        ) : null}
      </View>
      <View style={[styles.trail, roomy && styles.roomyTrail]}>
        {people.length > 0 ? <Faces people={people.slice(0, 3)} theme={theme} pressed={pressed} /> : null}
        {has ? (copied ? <Check size={20} color={theme.muted} strokeWidth={2.25} /> : <Ellipsis size={20} color={theme.muted} strokeWidth={2} />) : null}
      </View>
    </Pressable>
  );
});

// The desktop's quiet Pill: its tone colours the text, never the fill. Muted for Ended and Removed, danger
// for Damaged.
function StatusPill({ status, theme }: { status: ShareStatus; theme: Theme }) {
  return (
    <View style={[styles.pill, { borderColor: theme.line, backgroundColor: theme.panel2 }]}>
      <Text style={[styles.pillText, { color: status === "damaged" ? theme.danger : theme.muted }]}>{sharingWords.status[status]}</Text>
    </View>
  );
}

// Up to three faces, overlapping, beside the people a share is named to.
function Faces({ people, theme, pressed }: { people: readonly SamplePerson[]; theme: Theme; pressed: boolean }) {
  return (
    <View style={styles.faces}>
      {people.map((person, index) => (
        <View key={person.email} style={[styles.face, { backgroundColor: person.hue, borderColor: pressed ? theme.panel2 : theme.bg, marginLeft: index ? -4 : 0 }]}>
          {/* The circle is a fixed size, so its initials don't grow with text size; the row's label names the person. */}
          <Text allowFontScaling={false} style={styles.initials}>{person.initials}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 60, paddingHorizontal: 16, paddingVertical: 8 },
  lead: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, gap: 2 },
  name: { fontSize: 17 },
  second: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  who: { flex: 1, fontSize: 14, lineHeight: 19 },
  pill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 7, height: 19, justifyContent: "center" },
  pillText: { fontSize: 12 },
  trail: { flexDirection: "row", alignItems: "center", gap: 10 },
  // At accessibility sizes: the text keeps the row's width, and the trail wraps under it, starting where the text does.
  roomyRow: { flexWrap: "wrap", alignItems: "flex-start" },
  roomyTrail: { width: "100%", paddingLeft: 40, marginTop: 4 },
  faces: { flexDirection: "row" },
  face: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  initials: { color: "#fff", fontSize: 10, fontWeight: "700" },
});
