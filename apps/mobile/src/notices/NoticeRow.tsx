import { noticesWords } from "@dohc/interface-words/notices";
import * as Haptics from "expo-haptics";
import { CheckCircle2, Mail, X } from "lucide-react-native";
import { memo, useEffect, useRef, useState } from "react";
import { demoMode } from "../demo";
import {
  AccessibilityInfo,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type ViewInstance,
} from "react-native";
import ReanimatedSwipeable, {
  SwipeDirection,
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { useAccessibilityTextSize, useLineClamp } from "../textScale";
import { useTheme } from "../theme";
import type { PhoneNotice } from "./phoneNotice";
import { copyText } from "../copy";
import { ActionPill } from "./ActionPill";
import { WakeState } from "../conversation/WakeState";
import { AnswerStatus, NoticeAnswer } from "./NoticeAnswer";
import {
  ageMinutes,
  dismissLabel,
  isExpanded,
  marksRead,
  noticeDetails,
  noticeMeta,
  noticeRowAccessibility,
  noticeRowHandlers,
  shortAgo,
  swipesUnread,
  wordedLabel,
} from "./rowAccessibility";
import { useRouter } from "expo-router";
import { SenderMark } from "./SenderMark";
import { TitleControls } from "./TitleControls";

export const NoticeRow = memo(function NoticeRow({
  notice,
  onDismiss,
  onSetRead,
}: {
  notice: PhoneNotice;
  /** Done for a Notice from the server; Dismiss for a failure held on this phone. */
  onDismiss(id: string): void;
  /** Mark read or Mark unread, for a Notice from the server. */
  onSetRead?(id: string, read: boolean): void;
}) {
  const theme = useTheme();
  const titleLines = useLineClamp(3);
  const roomy = useAccessibilityTextSize();
  const bodyLines = useLineClamp(3);
  // As on the desktop, a tap on a clipped title or body shows all of it in place; the row has no other tap.
  const [open, setOpen] = useState(
    demoMode === "notice-clipped-open" && notice.id === "n-end-failed",
  );
  const toggle = () => setOpen((value) => !value);
  // Design review only: "swipe-open" holds the first row's swipe action open, so its × inset can be shot.
  const swipeable = useRef<SwipeableMethods>(null);
  const swipeOpen = demoMode === "swipe-open" && notice.id === "n1";
  useEffect(() => {
    if (!swipeOpen) return;
    const timer = setTimeout(() => swipeable.current?.openRight(), 900);
    return () => clearTimeout(timer);
  }, [swipeOpen]);
  const dismiss = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onDismiss(notice.id);
  };
  const setRead = (read: boolean) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSetRead?.(notice.id, read);
  };
  const router = useRouter();
  const { label, actions } = noticeRowAccessibility(notice);
  // While the row's answer is open, its pill is Open. While it's open, or this phone has an answer on it that isn't
  // saved, it has no Done and no swipe, so Done never hides an answer that still needs the person. Closing it puts
  // VoiceOver back on the row, after layout.
  const answer = notice.answer;
  const editing = answer !== undefined && answer.editing !== null;
  const expanded = isExpanded(notice);
  const rowRef = useRef<ViewInstance>(null);
  const wasEditing = useRef(editing);
  useEffect(() => {
    const was = wasEditing.current;
    wasEditing.current = editing;
    if (!was || editing) return;
    const frame = requestAnimationFrame(() => {
      if (rowRef.current) AccessibilityInfo.sendAccessibilityEvent(rowRef.current, "focus");
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);
  // Open goes where the phone can go, Reply opens a mention's thread with its message chosen, Answer opens the row's
  // answer, and Try again does what the notice says failed. In the dev-only sample, Try again and an Open with nowhere
  // to go need the server, so they do nothing.
  const handlers = noticeRowHandlers(notice, {
    open:
      notice.onOpen ??
      (notice.openChat
        ? () => router.push({ pathname: "/chat/[id]", params: notice.openChat ?? {} })
        : undefined),
    retry: notice.onRetry,
    retryTarget: notice.retryTarget,
    setRead: onSetRead ? setRead : undefined,
    copy: () => copyText(noticeDetails(notice)),
    dismiss,
  });
  const readToggle = marksRead(notice) && onSetRead !== undefined;
  const worded = editing ? (answer.open ? noticesWords.open : null) : wordedLabel(notice);
  const onWorded = editing ? answer.open : handlers.worded;
  // Expanded, the answer's own wake lines carry their Try again.
  const retryWakes = expanded ? undefined : handlers.retryWakes;
  const pills = worded !== null || readToggle || retryWakes !== undefined;
  const done = notice.relayId !== undefined;
  const onAction = (event: AccessibilityActionEvent) => handlers[event.nativeEvent.actionName]?.();
  const controls = (
    <TitleControls
      copyLabel={notice.failed ? noticesWords.copyErrorDetails : noticesWords.copyNoticeDetails}
      onCopy={handlers.copy}
      dismissLabel={notice.dismissible && !expanded ? dismissLabel(notice) : undefined}
      onDismiss={dismiss}
      done={done}
      demoCopied={demoMode === "notice-copied" && notice.id === "n1"}
      // On the action line their 44pt targets reach 11pt past each icon, so they keep clear of the pill's.
      style={roomy && pills ? styles.actionControls : undefined}
    />
  );
  // Collapsed, the row is one element with its actions in the rotor. Expanded, it's a group: each text and control is
  // reached on its own, and none sits under an accessible parent.
  const row = (
    <View
      ref={rowRef}
      style={[styles.row, { backgroundColor: theme.bg }]}
      accessibilityLabel={label}
      {...(expanded
        ? { accessible: false }
        : { accessible: true, accessibilityActions: actions, onAccessibilityAction: onAction })}
    >
      {notice.read ? null : <View style={[styles.dot, { backgroundColor: theme.accent }]} />}
      <SenderMark kind={notice.senderKind} failed={notice.failed === true} />
      <View style={styles.main}>
        <View style={styles.titleLine}>
          <Text
            style={[
              styles.title,
              {
                color: notice.read ? theme.muted : theme.ink,
                fontWeight: notice.read ? "500" : "600",
              },
            ]}
            numberOfLines={open ? undefined : titleLines}
            onPress={toggle}
            suppressHighlighting
          >
            {notice.title}
          </Text>
          {roomy ? null : controls}
        </View>
        {notice.body ? (
          <Text
            style={[styles.body, { color: theme.muted }]}
            numberOfLines={open ? undefined : bodyLines}
            onPress={toggle}
            suppressHighlighting
          >
            {notice.body}
          </Text>
        ) : null}
        {answer ? (
          expanded ? (
            <NoticeAnswer answer={answer} />
          ) : (
            <>
              <AnswerStatus answer={answer} />
              {/* One element collapsed: its Try again is the row's pill and rotor action. */}
              {answer.wakes ? (
                <WakeState wakes={answer.wakes.wakes} failed={answer.wakes.failed} />
              ) : null}
            </>
          )
        ) : null}
        {notice.retryTarget ? (
          <Text style={[styles.body, { color: theme.danger }]}>
            {noticesWords.targetReadFailed}
          </Text>
        ) : null}
        {pills || roomy ? (
          <View style={styles.actions}>
            {worded !== null ? <ActionPill label={worded} onPress={onWorded} /> : null}
            {notice.retryTarget ? (
              <ActionPill label={noticesWords.tryAgain} onPress={handlers.retryTarget} />
            ) : null}
            {retryWakes ? <ActionPill label={noticesWords.tryAgain} onPress={retryWakes} /> : null}
            {/* Mark unread is also the swipe right. */}
            {readToggle ? (
              <ActionPill
                label={notice.read ? noticesWords.markUnread : noticesWords.markRead}
                onPress={handlers.read}
              />
            ) : null}
            {roomy ? controls : null}
          </View>
        ) : null}
        <Text style={[styles.meta, { color: theme.subtle }]}>
          {noticeMeta(notice, shortAgo(ageMinutes(notice)))}
        </Text>
      </View>
    </View>
  );
  if (!notice.dismissible || expanded) return row;
  // Swiping left is Done, or Dismiss for a failure held on this phone. Swiping right marks a read Notice from the
  // server unread, then springs back; an unread one offers no swipe right. A wake, which the phone's scope leaves out,
  // isn't dismissible, so it has no swipe at all.
  return (
    <ReanimatedSwipeable
      ref={swipeable}
      friction={2}
      leftThreshold={64}
      rightThreshold={64}
      overshootLeft={false}
      overshootRight={false}
      onSwipeableOpen={
        swipeOpen
          ? undefined
          : (direction) => {
              if (direction === SwipeDirection.LEFT) return dismiss();
              swipeable.current?.close();
              setRead(false);
            }
      }
      renderLeftActions={
        readToggle && swipesUnread(notice)
          ? () => (
              <View style={[styles.swipe, { backgroundColor: theme.panel2 }]}>
                <Mail size={22} color={theme.ink} strokeWidth={2} />
              </View>
            )
          : undefined
      }
      renderRightActions={() => (
        <View style={[styles.swipe, { backgroundColor: theme.panel2 }]}>
          {done ? (
            <CheckCircle2 size={22} color={theme.ink} strokeWidth={2} />
          ) : (
            <X size={22} color={theme.ink} strokeWidth={2} />
          )}
        </View>
      )}
    >
      {row}
    </ReanimatedSwipeable>
  );
});

const styles = StyleSheet.create({
  // The mark sits on the 16pt inset like the title above it; the unread dot is centred in that gutter, as in Mail.
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 12,
    paddingLeft: 16,
    paddingRight: 16,
    gap: 10,
  },
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
