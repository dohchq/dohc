import { noticesWords, syncProblemSentence } from "@dohc/interface-words/notices";
import { grantedWho, receivedWho, sharingWords, type ShareLane } from "@dohc/interface-words/sharing";
import { Stack, useIsFocused } from "expo-router";
import { CheckCircle2 } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { BarBand, nativeBarBand } from "../../../modules/bar-band";
import { choose, confirm } from "../../../src/confirm";
import { copyText } from "../../../src/copy";
import { demoMode } from "../../../src/demo";
import { useNotices } from "../../../src/notices/NoticesState";
import { useShowToast } from "../../../src/notices/Toast";
import { useSyncBandHost } from "../../../src/notices/useSyncBandHost";
import { cutMiddle } from "../../../src/sharing/cutMiddle";
import { ShareRow } from "../../../src/sharing/ShareRow";
import { endable, sampleGranted, sampleReceived, type GrantedShare } from "../../../src/sharing/sample";
import { useTheme } from "../../../src/theme";
import { sampleOnly } from "../../../src/sampleOnly";

// Stands in for when the server last answered; the simulator's clock reads 9:41.
const CHECKED_AT = "9:41";
// A failed End share's toast title fits 2 lines: the file's name and each person's are cut in the
// middle to these many characters, and the title stops at 2 lines.
const TOAST_FILE = 20;
const TOAST_PERSON = 16;
// Stands in for the server's answer to End share.
const endOutcome = demoMode === "toast-end-failed" || demoMode === "toast-end-failed-many" ? "failed" : demoMode === "toast-already-ended" ? "already" : "ended";

const actionsOf = (share: GrantedShare) => endable(share) ? [
  ...(share.invitation ? [{ name: "copy", label: sharingWords.copyInvitation }] : []),
  { name: "end", label: sharingWords.endShareMenu, destructive: true },
] : [];

// The desktop's Sharing view: what this workspace shares, then what's shared with you. A share named to
// people ends here, with Undo for 10 minutes. Links and chats end where they were made. The sync band is drawn as
// on Notices: fixed at the bar's bottom in the native host, over the lanes.
function Sharing() {
  const theme = useTheme();
  const band = useSyncBandHost({ ready: true, opened: useIsFocused() });
  const showToast = useShowToast();
  const { add: addNotice } = useNotices();
  const empty = demoMode === "sharing-empty";
  const [granted, setGranted] = useState<readonly GrantedShare[]>(empty ? [] : sampleGranted);
  const received = empty ? [] : sampleReceived;
  const [copiedId, setCopiedId] = useState<string | null>(null);
  useEffect(() => {
    if (!copiedId) return;
    const timer = setTimeout(() => setCopiedId(null), demoMode === "share-copied" ? 60_000 : 1500);
    return () => clearTimeout(timer);
  }, [copiedId]);

  const end = useCallback(async (share: GrantedShare, ask = true): Promise<void> => {
    const people = share.grants.map(grant => grant.who);
    // The alert names the file. With changes waiting, it says ending the share declines them.
    const { waiting } = share;
    if (ask && !await confirm({
      title: waiting ? sharingWords.endWaitingTitle(share.name, waiting.count, waiting.senders) : sharingWords.endTitle(share.name),
      message: waiting ? sharingWords.endWaitingBody(waiting.count) : sharingWords.endBody(people),
      confirm: sharingWords.endShare, destructive: true,
    })) return;
    const subject = sharingWords.subject(share.title, people);
    // As on the desktop: ended with Undo, already ended with none, or a failure that stays in Notices.
    if (endOutcome === "failed") {
      const title = sharingWords.endFailed(subject);
      const body = syncProblemSentence.serverUnreachable;
      addNotice({ id: `end-${share.shareId}-${Date.now()}`, senderKind: null, senderLabel: "", title, body, minutesAgo: 0,
        read: false, retry: true, dismissible: true, failed: true });
      // The toast's title fits two lines; its Notices row and Copy keep the whole of it.
      const short = sharingWords.subject(cutMiddle(share.name, TOAST_FILE), people.map(person => cutMiddle(person, TOAST_PERSON)));
      showToast({ tone: "failure", title: sharingWords.endFailed(short), fullTitle: title, titleLines: 2, body, action: { label: noticesWords.tryAgain, onPress: () => void end(share, false) } });
      return;
    }
    let index = -1;
    setGranted(list => { index = list.indexOf(share); return list.filter(entry => entry !== share); });
    if (endOutcome === "already") {
      showToast({ tone: "success", title: sharingWords.alreadyEnded(subject) });
      return;
    }
    showToast({ tone: "success", title: sharingWords.endedShare(subject), body: sharingWords.undoWindow, action: { label: sharingWords.undo, onPress: () => {
      setGranted(list => list.includes(share) ? list : [...list.slice(0, index), share, ...list.slice(index)]);
      showToast({ tone: "success", title: sharingWords.restored(subject) });
    } } });
  }, [addNotice, showToast]);

  // A tap opens the row's actions; VoiceOver names one directly.
  const act = useCallback(async (share: GrantedShare, name: string | null) => {
    const actions = actionsOf(share);
    const chosen = name ?? actions[await choose({ title: share.name, options: actions }) ?? -1]?.name;
    if (chosen === "end") await end(share);
    if (chosen === "copy" && share.invitation) { copyText(share.invitation); setCopiedId(share.shareId); }
  }, [end]);

  useDemoSheet(granted, act, end);

  // The scroll view is the host's first child, so the large title folds with it and iOS keeps the lanes below the band.
  return (
    <>
      <Stack.Screen options={{ title: sharingWords.heading }} />
      <BarBand style={styles.fill} coverHeight={band.coverHeight} onSpace={band.onSpace}>
        <ScrollView {...band.scrollHandlers} contentInsetAdjustmentBehavior="automatic" style={{ backgroundColor: theme.bg }} contentContainerStyle={styles.content}
          // On Android the indicator starts where the content does, below the band. On iOS the covered strip does it.
          scrollIndicatorInsets={nativeBarBand ? undefined : { top: band.spacer ? band.bandHeight ?? 0 : 0 }}>
          {band.spacer ? <View style={{ height: band.bandHeight }} /> : null}
          <Lane lane="granted" count={granted.length}>
            {granted.map(share => (
              <ShareRow key={share.shareId} kind={share.kind} name={share.name} who={grantedWho(share.grants)} status={null} people={share.people}
                actions={actionsOf(share)} onAction={name => void act(share, name)} copied={copiedId === share.shareId} />
            ))}
          </Lane>
          <Lane lane="received" count={received.filter(share => share.status === null).length}>
            {received.map(share => {
              const who = receivedWho(share.sender, share.status ? null : share.level);
              return (
                <ShareRow key={share.shareId} kind={share.kind} name={share.name} who={who.text} spokenWho={who.spoken} status={share.status}
                  people={[share.senderPerson]} actions={[]} onAction={() => {}} />
              );
            })}
          </Lane>
        </ScrollView>
        {band.band}
      </BarBand>
      {band.measurers}
    </>
  );
}

// A lane's heading with its count, when the server last answered and for what, then its rows or the empty note.
function Lane({ lane, count, children }: { lane: ShareLane; count: number; children: ReactNode[] }) {
  const theme = useTheme();
  const words = sharingWords.lane[lane];
  return (
    <View style={styles.lane}>
      <View style={styles.heading} accessible accessibilityRole="header" accessibilityLabel={`${words.label}, ${count}`}>
        <Text style={[styles.label, { color: theme.muted }]}>{words.label}</Text>
        <Text style={[styles.count, { color: theme.subtle }]}>{count}</Text>
      </View>
      <View style={styles.checked} accessible>
        <CheckCircle2 size={13} color={theme.subtle} strokeWidth={2} />
        <Text style={[styles.checkedText, { color: theme.subtle }]}>{sharingWords.checked}</Text>
        <Text style={[styles.checkedText, styles.time, { color: theme.subtle }]}>{CHECKED_AT}</Text>
        <Text style={[styles.checkedText, { color: theme.subtle }]}>{words.scope}</Text>
      </View>
      {children.length > 0 ? children : <Text style={[styles.empty, { color: theme.muted }]}>{words.empty}</Text>}
    </View>
  );
}

// Design review only: opens a row's sheet, the end confirmation, or the ended toast once, without a tap.
function useDemoSheet(granted: readonly GrantedShare[], act: (share: GrantedShare, name: string | null) => Promise<void>,
  end: (share: GrantedShare, ask?: boolean) => Promise<void>) {
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    const packing = granted.find(share => share.shareId === "s-packing");
    const itinerary = granted.find(share => share.shareId === "s-itinerary");
    const timer = setTimeout(() => {
      opened.current = true;
      if (demoMode === "sheet-share-actions" && packing) void act(packing, null);
      if (demoMode === "share-copied" && packing) void act(packing, "copy");
      if (demoMode === "sheet-end-share" && itinerary) void act(itinerary, "end");
      if (demoMode === "sheet-end-share-waiting" && packing) void act(packing, "end");
      if (demoMode === "toast-end-failed-many" && itinerary) void end(itinerary, false);
      if ((demoMode === "toast-ended" || demoMode === "toast-already-ended" || demoMode === "toast-end-failed") && packing) void end(packing, false);
    }, 600);
    return () => clearTimeout(timer);
  }, [act, end, granted]);
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingBottom: 140 },
  lane: { marginTop: 8 },
  heading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 36, paddingHorizontal: 16 },
  label: { fontSize: 15, fontWeight: "600" },
  count: { fontSize: 13, fontVariant: ["tabular-nums"] },
  // Wraps at the largest text sizes rather than running off the screen.
  checked: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 6, paddingHorizontal: 16, paddingBottom: 6 },
  checkedText: { fontSize: 13 },
  time: { fontVariant: ["tabular-nums"] },
  empty: { fontSize: 15, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 10 },
});

export default sampleOnly(Sharing);
