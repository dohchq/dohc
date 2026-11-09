import { noticesWords } from "@dohc/interface-words/notices";
import { AlertTriangle, CheckCircle2 } from "lucide-react-native";
import { createContext, useContext, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLineClamp } from "../textScale";
import { useTheme } from "../theme";
import type { SenderKind } from "./sample";
import { ActionPill } from "./ActionPill";
import { SenderMark } from "./SenderMark";
import { TitleControls } from "./TitleControls";
import { copyText } from "../copy";
import { demoMode } from "../demo";

export interface ToastMessage {
  readonly tone: "success" | "failure";
  readonly title: string;
  /** The title in full, when the one shown is cut to fit. Copy hands this out. */
  readonly fullTitle?: string;
  /** Fewer title lines than the usual 4, for a title written to fit them. */
  readonly titleLines?: number;
  readonly body?: string;
  /** One worded action under the text: Try again, Undo. */
  readonly action?: { readonly label: string; onPress?(): void };
  /** A sent notice's toast carries its row's sender mark; without one, a failure is held on this phone. */
  readonly sender?: SenderKind;
}

// Any screen under the tabs shows a toast through this; the tabs layout owns the one on screen.
export const ShowToast = createContext<(message: ToastMessage) => void>(() => {});
export const useShowToast = () => useContext(ShowToast);

// How long a success stays before it fades; failures stay until closed. Same as the desktop.
const FADING_TOAST_MS = 6000;

// The desktop's toast on a phone: bottom, full width in 16pt gutters above the tab bar.
// Copy and × on the title line, worded actions on a row under the text. Closing it keeps its row in Notices.
export function Toast({ message, onClose }: { message: ToastMessage; onClose(): void }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const success = message.tone === "success";
  // A toast's text column is narrower than a row's, so its title gets a fourth line. A tap shows the rest.
  const titleLines = useLineClamp(message.titleLines ?? 4);
  const bodyLines = useLineClamp(3);
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen(value => !value);
  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(onClose, FADING_TOAST_MS);
    return () => clearTimeout(timer);
  }, [success, onClose]);
  return (
    <Animated.View entering={FadeInDown.duration(220)} exiting={FadeOutDown.duration(180)}
      style={[styles.toast, { bottom: insets.bottom + 66, backgroundColor: theme.raised, borderColor: theme.raisedLine }]}
      accessibilityRole="alert">
      <View style={styles.titleLine}>
        {message.sender ? <SenderMark kind={message.sender} failed={message.tone === "failure"} /> : (
          <View style={styles.mark}>
            {success
              ? <CheckCircle2 size={18} color={theme.success} strokeWidth={2} />
              : <AlertTriangle size={18} color={theme.danger} strokeWidth={2} />}
          </View>
        )}
        <Text style={[styles.title, { color: theme.ink }]} numberOfLines={open ? undefined : titleLines}
          onPress={toggle} suppressHighlighting>{message.title}</Text>
        <TitleControls copyLabel={success ? undefined : noticesWords.copyErrorDetails}
          onCopy={() => copyText([message.fullTitle ?? message.title, message.body].filter(Boolean).join("\n"))} onDismiss={onClose}
          demoCopied={demoMode === "toast-copied"} style={styles.controls}
          dismissLabel={success ? noticesWords.dismissWorkspaceNotice : noticesWords.dismissWorkspaceError} />
      </View>
      {message.body ? <Text style={[styles.body, { color: theme.muted }]} numberOfLines={open ? undefined : bodyLines} onPress={toggle} suppressHighlighting>{message.body}</Text> : null}
      {message.action ? (
        <View style={styles.actions}>
          <ActionPill label={message.action.label} onPress={() => { message.action?.onPress?.(); onClose(); }} />
        </View>
      ) : null}
    </Animated.View>
  );
}

// The mark column is 30pt, as in a Notices row; text lines up after it and the 10pt gap.
const TEXT_INSET = 40;

const styles = StyleSheet.create({
  toast: {
    position: "absolute", left: 16, right: 16, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 2,
    shadowColor: "#000", shadowOpacity: 0.14, shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
  },
  titleLine: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  mark: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  // As in a row: the title's first line, the mark and the controls share one centre.
  title: { flex: 1, fontSize: 16, fontWeight: "600", lineHeight: 21, marginTop: 4.5 },
  controls: { marginTop: 4 },
  body: { fontSize: 15, lineHeight: 20, marginLeft: TEXT_INSET },
  actions: { flexDirection: "row", gap: 8, marginTop: 6, marginLeft: TEXT_INSET },
});
