import { noticesWords } from "@dohc/interface-words/notices";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import { Stack, useIsFocused } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { Check } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, ScrollView, StyleSheet, Text, View } from "react-native";
import { File, Paths } from "expo-file-system";
import { BarBand, nativeBarBand } from "../../../modules/bar-band";
import { demoMode, demoScroll } from "../../../src/demo";
import { NoticesFrameProbe } from "../../../src/firstScreenProbe";
import { NoticeRow } from "../../../src/notices/NoticeRow";
import { useNotices } from "../../../src/notices/NoticesState";
import type { PhoneNotice } from "../../../src/notices/sample";
import { useSyncBandHost, type BandRecord } from "../../../src/notices/useSyncBandHost";
import { NotYet } from "../../../src/NotYet";
import { sampleBuild } from "../../../src/sampleBuild";
import { useTheme } from "../../../src/theme";

export default function Notices() {
  return sampleBuild ? <SampleNotices /> : <ServerNotices />;
}

// A signed-in build reads no notices from the server yet, so the tab says so instead of showing any.
function ServerNotices() {
  const theme = useTheme();
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" alwaysBounceVertical={false} style={{ backgroundColor: theme.bg }} contentContainerStyle={{ flexGrow: 1 }}>
      <Stack.Screen options={{ title: noticesWords.heading }} />
      <NotYet symbol="bell" title={noticesWords.heading} />
    </ScrollView>
  );
}

function SampleNotices() {
  const theme = useTheme();
  const list = useRef<LegendListRef>(null);
  const { notices, unread, dismiss, markAllRead } = useNotices();
  // Native tabs build every tab at launch. Notices' rows wait for the first idle moment after launch, so launch
  // doesn't pay for a screen nobody sees yet, or render at once if the tab is opened first.
  const opened = useIsFocused();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (opened && demoMode === "notices-open") markOpen("focusAt");
    if (ready) return;
    const readyBy = (how: string) => { if (demoMode === "notices-open") markOpen("readyBy", how); setReady(true); };
    if (opened) { readyBy("focus"); return; }
    const idle = requestIdleCallback(() => readyBy("idle"));
    return () => cancelIdleCallback(idle);
  }, [opened, ready]);

  // The sync band, as the shared host draws it. The round's records are kept only in the demos that read them.
  const band = useSyncBandHost({ ready, opened, record: noticesRecord });
  const { problem: shownProblem, bandHeight, coverHeight } = band;
  useEffect(() => {
    if (!announcing) return;
    const finished = AccessibilityInfo.addEventListener("announcementFinished", ({ announcement, success }) =>
      markAnnouncement({ finished: announcement, success }));
    return () => finished.remove();
  }, []);

  // Design review only: scroll so the fixed band can be checked in a screenshot, mid-list or partway through the fold.
  // At rest the list sits above zero by the bar's height, so partway is demoScroll past that.
  const restingBar = useRef(0);
  const restingCover = useRef(0);
  restingBar.current = useHeaderHeight();
  // Design review only: the bar's height with the title open, for the jump demos below. It follows the header until the
  // first drag, so it's the measured resting height, not the default the header reports before layout (44 pt plus the
  // status bar); then it's frozen, since the folded bar is shorter.
  const openBar = useRef(0);
  const openFrozen = useRef(false);
  if (!openFrozen.current) openBar.current = restingBar.current;
  useEffect(() => {
    if (demoMode === "band-scrolled") {
      const timer = setTimeout(() => list.current?.scrollToOffset({ offset: 420, animated: false }), 800);
      return () => clearTimeout(timer);
    }
    if (demoMode !== "band-half-fold") return;
    const timer = setTimeout(() => list.current?.getNativeScrollRef().scrollTo({ y: demoScroll - restingBar.current - restingCover.current, animated: false }), 1500);
    return () => clearTimeout(timer);
  }, []);

  // Design review only: in band-return-scroll and band-cycle-scroll, each return to Notices sends the list to its top at
  // once, with no finger on it, while the host still settles the return.
  const away = useRef(false);
  useEffect(() => {
    if (!opened) { away.current = true; return; }
    if (!away.current) return;
    away.current = false;
    if (demoMode === "band-return-scroll" || demoMode === "band-cycle-scroll") {
      // To the top with the title open, so the title unfolds and iOS corrects the inset after the jump. iOS
      // adds the inset the title gains to the offset, so the list comes to rest past its top by the title's unfolding.
      const target = -openBar.current - restingCover.current;
      list.current?.getNativeScrollRef().scrollTo({ y: target, animated: false });
      markJump(target);
    }
  }, [opened]);

  const header = (
    <>
      <Stack.Screen options={{ title: noticesWords.heading }} />
      {demoMode === "notices-frames" ? <NoticesFrameProbe /> : null}
      {/* A system bar button: the platform draws its padding, glass, label colour and pressed state. A tint of
          our own made its label read as disabled on dark glass. */}
      {unread > 0 ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button onPress={markAllRead}>{noticesWords.markAllRead}</Stack.Toolbar.Button>
        </Stack.Toolbar>
      ) : null}
    </>
  );
  // One list in every state, so nothing remounts when the band comes or goes. The band reports the whole workspace
  // and never scrolls away, so it's drawn over the list at the bar's bottom. On iOS the native host covers the band's
  // strip, so iOS keeps rows, focus and the indicator below it. On Android the list's first row is an empty space of
  // the band's height instead, arriving and leaving in the band's commit.
  restingCover.current = coverHeight;
  const items: Item[] = band.spacer
    ? [{ kind: "band" as const }, ...notices.map(notice => ({ kind: "notice" as const, notice }))]
    : notices.map(notice => ({ kind: "notice" as const, notice }));
  const rows = (
    <LegendList
      ref={list}
      data={items}
      {...band.scrollHandlers}
      onScrollBeginDrag={() => { openFrozen.current = true; band.scrollHandlers.onScrollBeginDrag(); }}
      // The space's key carries its height, so the list never reuses a size it cached for an earlier height.
      keyExtractor={item => item.kind === "band" ? `band:${bandHeight}` : item.notice.id}
      getItemType={item => item.kind}
      getFixedItemSize={item => item.kind === "band" ? bandHeight : undefined}
      estimatedItemSize={128}
      style={{ backgroundColor: theme.bg }}
      // Room for the bar and the tab bar, so the last row ends at the tab bar, with or without the band.
      contentInsetAdjustmentBehavior="automatic"
      // Design review only: lets the partway-fold demo scroll to a resting offset above zero, or below the top for a
      // pull-down.
      scrollToOverflowEnabled={demoMode === "band-half-fold" || demoMode === "band-return-scroll" || demoMode === "band-cycle-scroll"}
      // On Android the indicator starts where the content does, below the band. On iOS the covered strip does it.
      scrollIndicatorInsets={nativeBarBand ? undefined : { top: shownProblem ? bandHeight ?? 0 : 0 }}
      ListFooterComponent={notices.length === 0 ? (
        <View style={styles.empty} testID="notices-empty">
          {/* Under a problem band nothing is all clear, so the empty list says only that no other notices wait. */}
          {shownProblem ? null : <Check size={40} color={theme.subtle} strokeWidth={1.75} />}
          <Text style={[styles.emptyText, { color: theme.ink }]}>{shownProblem ? noticesWords.noOtherNotices : noticesWords.allClear}</Text>
        </View>
      ) : undefined}
      renderItem={({ item }) => item.kind === "band"
        ? <View style={{ height: bandHeight }} />
        : item.notice.id === notices[0]?.id && demoMode === "notices-open"
          // Design review only: when the first row is laid out, for the time from a tab tap to rows on screen.
          ? <View onLayout={() => markOpen("rowsAt")}><NoticeRow notice={item.notice} onDismiss={dismiss} /></View>
          : <NoticeRow notice={item.notice} onDismiss={dismiss} />}
    />
  );

  // The list is the first view down the screen's chain of first children, as Home's and Sharing's scroll views are: the
  // large title only folds for a scroll view it finds there.
  return (
    <>
      {header}
      {/* The list, then the band: the list stays the first child, which the title folds with. */}
      <BarBand style={styles.fill} coverHeight={coverHeight} onSpace={band.onSpace}>
        {ready ? rows : null}
        {band.band}
      </BarBand>
      {band.measurers}
    </>
  );
}

/** Design review only: in band-hold.json, when the last finger last lifted before the band's first change, and when
 * that change applied. The round compares the two on the app's own clock. */
const hold: Record<string, number> = {};
function markHold(step: "released" | "applied") {
  if ("applied" in hold) return;
  hold[step] = Date.now();
  void new File(Paths.document, "band-hold.json").write(JSON.stringify(hold));
}

/** Design review only: each announcement sent, and each VoiceOver finished with whether it was cut off, in
 * band-announcements.json. The round checks the band's title is sent once on arrival, never at launch or on leave, and
 * finishes uncut. */
const announcing = demoMode === "band" || demoMode === "band-late";
const announcements: Record<string, string | boolean>[] = [];
function markAnnouncement(entry: Record<string, string | boolean>) {
  announcements.push(entry);
  void new File(Paths.document, "band-announcements.json").write(JSON.stringify(announcements));
}

/** Design review only: every space the host reported, with the time it arrived, in band-space.json. The round checks
 * that scrolling and folding the title send none. */
const spaces: { height: number; at: number }[] = [];
/** Design review only: each jump's requested offset, in band-jump.json, to set against the offset the trace records. */
const jumps: { target: number; at: number }[] = [];
function markJump(target: number) {
  jumps.push({ target, at: Date.now() });
  void new File(Paths.document, "band-jump.json").write(JSON.stringify(jumps));
}

function markSpace(height: number) {
  spaces.push({ height, at: Date.now() });
  void new File(Paths.document, "band-space.json").write(JSON.stringify(spaces));
}

/** Design review only: what the band did, in the demos whose records a script reads. */
const noticesRecord: BandRecord = {
  space: demoMode === "band" ? height => markSpace(height) : undefined,
  hold: demoMode === "band-toggle" ? step => markHold(step) : undefined,
  sent: announcing ? sent => markAnnouncement({ sent }) : undefined,
};

type Item = { kind: "band" } | { kind: "notice"; notice: PhoneNotice };

/** Design review only: the first time Notices gained focus and its first row was laid out, in notices-open.json.
 * A first visit shows its rows max(0, rowsAt - focusAt) after the tab gains focus. */
const opening: Record<string, number | string> = {};
function markOpen(step: string, value: number | string = Date.now()) {
  if (step in opening) return;
  opening[step] = value;
  void new File(Paths.document, "notices-open.json").write(JSON.stringify(opening));
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  // iOS's empty-content proportions, a little under the middle of the space between title and tab bar.
  empty: { alignItems: "center", gap: 12, paddingTop: 200 },
  emptyText: { fontSize: 20, fontWeight: "600" },
});
