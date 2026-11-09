import { Check, Copy, X } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../theme";

// Copy and × on a notice's title line, each a 44pt target that doesn't overlap the other.
// Without a dismiss label, the × column stays empty so every copy button lines up.
export function TitleControls({ copyLabel, onCopy, dismissLabel, onDismiss, style, demoCopied = false }: {
  copyLabel?: string; onCopy?(): void; dismissLabel?: string; onDismiss?(): void; style?: StyleProp<ViewStyle>;
  /** Design review only: copy once on mount, to shoot the check. */
  demoCopied?: boolean;
}) {
  const theme = useTheme();
  // A check stands in for the copy icon briefly after copying, as the desktop's button says "Copied".
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), demoCopied ? 60_000 : 1500);
    return () => clearTimeout(timer);
  }, [copied, demoCopied]);
  useEffect(() => {
    if (!demoCopied || !onCopy) return;
    const timer = setTimeout(() => { onCopy(); setCopied(true); }, 1200);
    return () => clearTimeout(timer);
    // Once, on mount.
  }, []);
  return (
    <View style={[styles.controls, style]}>
      {copyLabel && onCopy ? (
        <Pressable onPress={() => { onCopy(); setCopied(true); }} accessibilityRole="button" accessibilityLabel={copyLabel} style={pressedBox}>
          {copied ? <Check size={17} color={theme.subtle} strokeWidth={2.25} /> : <Copy size={17} color={theme.subtle} strokeWidth={2} />}
        </Pressable>
      ) : <View style={styles.box} />}
      {dismissLabel && onDismiss ? (
        <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel={dismissLabel} style={pressedBox}>
          <X size={17} color={theme.subtle} strokeWidth={2} />
        </Pressable>
      ) : <View style={styles.box} />}
    </View>
  );
}

const pressedBox = ({ pressed }: { pressed: boolean }) => [styles.box, pressed && styles.pressed];

const styles = StyleSheet.create({
  controls: { flexDirection: "row", gap: 22, marginTop: -0.5 },
  // Each control is a real 44pt square; the negative margin keeps it laid out as 22pt, so the columns don't move.
  box: { width: 44, height: 44, margin: -11, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.5 },
});
