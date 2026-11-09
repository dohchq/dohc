import { noticesWords } from "@dohc/interface-words/notices";
import * as Haptics from "expo-haptics";
import { X } from "lucide-react-native";
import { memo, useEffect, useRef, useState } from "react";
import { demoMode } from "../demo";
import { StyleSheet, Text, View, type AccessibilityActionEvent } from "react-native";
import ReanimatedSwipeable, { type SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useAccessibilityTextSize, useLineClamp } from "../textScale";
import { useTheme } from "../theme";
import { noticeDetails, type PhoneNotice } from "./sample";
import { copyText } from "../copy";
import { ActionPill } from "./ActionPill";
import { noticeRowAccessibility, noticeRowHandlers, shortAgo } from "./rowAccessibility";
import { useRouter } from "expo-router";
import { SenderMark } from "./SenderMark";
import { TitleControls } from "./TitleControls";

// One row in Notices, as on the desktop: unread dot, sender mark, title, body, worded actions on a row below,
// then the time. Copy and × sit on the title line; swiping dismisses too, and × stays visible. At accessibility text
// sizes they move to the action line, after the worded action, so the title has the row's full width.
// VoiceOver hears the row as one element with its actions in the rotor, the worded action first. A row has no
// tap of its own on screen, so it has no double-tap either.
export const NoticeRow = memo(function NoticeRow({ notice, onDismiss }: { notice: PhoneNotice; onDismiss(id: string): void }) {
  const theme = useTheme();
  const titleLines = useLineClamp(3);
  const roomy = useAccessibilityTextSize();
  const bodyLines = useLineClamp(3);
  // As on the desktop, a tap on a clipped title or body shows all of it in place; the row has no other tap.
  const [open, setOpen] = useState(demoMode === "notice-clipped-open" && notice.id === "n-end-failed");
  const toggle = () => setOpen(value => !value);
  // Design review only: "swipe-open" holds the first row's swipe action open, so its × inset can be shot.
  const swipeable = useRef<SwipeableMethods>(null);
  const swipeOpen = demoMode === "swipe-open" && notice.id === "n1";
  useEffect(() => {
    if (!swipeOpen) return;
    const timer = setTimeout(() => swipeable.current?.openRight(), 900);
    return () => clearTimeout(timer);
  }, [swipeOpen]);
  const dismiss = () => { void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); onDismiss(notice.id); };
  const router = useRouter();
  const { label, actions } = noticeRowAccessibility(notice);
  // Open goes where the phone can go (a chat). In this dev-only sample, Try again and an Open with nowhere to go
  // need the server; an installable build hides them until they act.
  const handlers = noticeRowHandlers(notice, {
    open: notice.openChat ? () => router.push({ pathname: "/chat/[id]", params: notice.openChat ?? {} }) : undefined,
    copy: () => copyText(noticeDetails(notice)),
    dismiss,
  });
  const onAction = (event: AccessibilityActionEvent) => handlers[event.nativeEvent.actionName]?.();
  const controls = (
    <TitleControls copyLabel={notice.failed ? noticesWords.copyErrorDetails : noticesWords.copyNoticeDetails} onCopy={handlers.copy}
      dismissLabel={notice.dismissible ? noticesWords.dismissNotice : undefined} onDismiss={dismiss}
      demoCopied={demoMode === "notice-copied" && notice.id === "n1"}
      // On the action line their 44pt targets reach 11pt past each icon, so they keep clear of the pill's.
      style={roomy && (notice.retry || notice.open) ? styles.actionControls : undefined} />
  );
  const row = (
    <View style={[styles.row, { backgroundColor: theme.bg }]} accessible accessibilityLabel={label}
      accessibilityActions={actions} onAccessibilityAction={onAction}>
      {notice.read ? null : <View style={[styles.dot, { backgroundColor: theme.accent }]} />}
      <SenderMark kind={notice.senderKind} failed={notice.failed === true} />
      <View style={styles.main}>
        <View style={styles.titleLine}>
          <Text style={[styles.title, { color: notice.read ? theme.muted : theme.ink, fontWeight: notice.read ? "500" : "600" }]}
            numberOfLines={open ? undefined : titleLines} onPress={toggle} suppressHighlighting>
            {notice.title}
          </Text>
          {roomy ? null : controls}
        </View>
        {notice.body ? <Text style={[styles.body, { color: theme.muted }]} numberOfLines={open ? undefined : bodyLines} onPress={toggle} suppressHighlighting>{notice.body}</Text> : null}
        {notice.retry || notice.open || roomy ? (
          <View style={styles.actions}>
            {notice.retry ? <ActionPill label={noticesWords.tryAgain} onPress={handlers.worded} /> : null}
            {notice.open ? <ActionPill label={notice.open === "openNote" ? noticesWords.openNote : noticesWords.open} onPress={handlers.worded} /> : null}
            {roomy ? controls : null}
          </View>
        ) : null}
        <Text style={[styles.meta, { color: theme.subtle }]}>{notice.folder ? `${shortAgo(notice.minutesAgo)} · ${notice.folder}` : shortAgo(notice.minutesAgo)}</Text>
      </View>
    </View>
  );
  if (!notice.dismissible) return row;
  return (
    <ReanimatedSwipeable ref={swipeable} friction={2} rightThreshold={64} overshootRight={false} onSwipeableOpen={swipeOpen ? undefined : dismiss}
      renderRightActions={() => (
        <View style={[styles.swipe, { backgroundColor: theme.panel2 }]}><X size={22} color={theme.ink} strokeWidth={2} /></View>
      )}>
      {row}
    </ReanimatedSwipeable>
  );
});

const styles = StyleSheet.create({
  // The mark sits on the 16pt inset like the title above it; the unread dot is centred in that gutter, as in Mail.
  row: { flexDirection: "row", alignItems: "flex-start", paddingVertical: 12, paddingLeft: 16, paddingRight: 16, gap: 10 },
  dot: { position: "absolute", left: 4, top: 23, width: 8, height: 8, borderRadius: 4 },
  // The 4.5pt top inset centres the title's first line on the 30pt mark, with the dot and controls.
  main: { flex: 1, gap: 2, paddingTop: 4.5 },
  titleLine: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  title: { flex: 1, fontSize: 16, lineHeight: 21 },
  body: { fontSize: 15, lineHeight: 20 },
  actions: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  actionControls: { marginLeft: 12 },
  meta: { fontSize: 13, marginTop: 2 },
  swipe: { width: 88, alignItems: "center", justifyContent: "center" },
});
