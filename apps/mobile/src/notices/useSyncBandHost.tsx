import { syncStatusWords } from "@dohc/interface-words/notices";
import { useAnimatedHeaderHeight } from "expo-router/native-stack";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, StyleSheet, View, useWindowDimensions, type GestureResponderEvent, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { nativeBarBand } from "../../modules/bar-band";
import { useSyncProblem } from "../demo";
import { SyncBand, type BandLinesLayout, type SyncProblem } from "./SyncBand";

/** Design review only: where a screen records what its band did, for the round to read. */
export interface BandRecord {
  space?(height: number): void;
  hold?(step: "released" | "applied"): void;
  sent?(announcement: string): void;
}

/** A sync band over a screen's list, as Notices draws it: the screen puts `band` after its list inside a BarBand host
 * with `coverHeight` and `onSpace`, spreads `scrollHandlers` on the list, and renders `measurers` beside the host.
 * On Android, where there's no host, the screen keeps an empty first item of `bandHeight` while `spacer` is true. */
export interface SyncBandHost {
  readonly problem: SyncProblem | null;
  readonly bandHeight: number | undefined;
  readonly coverHeight: number;
  readonly spacer: boolean;
  readonly onSpace: (event: { nativeEvent: { height: number } }) => void;
  readonly scrollHandlers: ReturnType<typeof useHeldWhileScrolling>["scrollHandlers"];
  readonly band: ReactNode;
  readonly measurers: ReactNode;
}

/** `ready`: the screen's list is mounted. `opened`: the screen has focus, for the arrival announcement. */
export function useSyncBandHost({ ready, opened, record }: { ready: boolean; opened: boolean; record?: BandRecord }): SyncBandHost {
  // Where the bar ends, on the UI thread, for Android, where the screen places the band itself. On iOS the native
  // host places it.
  const barBottom = useAnimatedHeaderHeight();
  // The band's geometry, measured before it shows: its height, by a hidden copy of the band for the problem it shows,
  // and on iOS the capped form's measures, by a second copy. The band and the space the list keeps for it both use that
  // height, so no row is ever under the band. Once the band shows, a change of Text Size, width or problem keeps the last
  // geometry until both copies are measured again, then the band and the rows change together, once.
  const { fontScale, width } = useWindowDimensions();
  const { problem: syncProblem, scrollHandlers } = useHeldWhileScrolling(useSyncProblem(), record?.hold);
  const toMeasure = syncProblem ?? "serverUnreachable";
  const size = `${fontScale}:${width}`;
  const [measured, setMeasured] = useState<{ problem: SyncProblem; size: string; height: number } | null>(null);
  const [linesMeasured, setLinesMeasured] = useState<{ problem: SyncProblem; size: string; layout: BandLinesLayout } | null>(null);
  const heightNow = measured?.problem === toMeasure && measured.size === size ? measured.height : undefined;
  // Android draws the band whole, so it needs no capped measures.
  const linesNow = !nativeBarBand ? undefined : linesMeasured?.problem === toMeasure && linesMeasured.size === size ? linesMeasured.layout : null;
  const lastGeometry = useRef<BandGeometry | null>(null);
  const geometry = heightNow !== undefined && linesNow !== null ? { problem: toMeasure, height: heightNow, lines: linesNow } : lastGeometry.current;
  // On iOS the space the host reports caps the band. A screen built off screen, as Notices is at launch, can't be
  // measured by the host, so the band doesn't wait for it: at standard sizes the cap never applies, and at the largest
  // sizes the band shrinks once when the space arrives.
  const [space, setSpace] = useState<number | null>(null);
  const showing = useRef(false);
  const shownProblem = syncProblem && geometry && (geometry.problem === toMeasure || showing.current) ? syncProblem : null;
  // Recorded after commit, so a render React abandons can't change them.
  useLayoutEffect(() => { showing.current = shownProblem !== null; lastGeometry.current = geometry; });
  // On iOS the band is at most half the space between the bar's resting edge and the tab bar, which the host reports.
  // A taller band's words scroll in a region of whole lines (the DL's a2), so the band is its fixed parts plus as many
  // whole lines as fit under the cap, and a row still shows at the largest text sizes.
  const half = nativeBarBand && space !== null ? space / 2 : undefined;
  const lines = geometry?.lines;
  const capped = geometry && lines && half !== undefined && geometry.height > half + 0.5 ? (() => {
    const fixed = lines.total - lines.text;
    const region = Math.min(lines.text, Math.max(lines.line, Math.floor((half - fixed) / lines.line) * lines.line));
    return { lines: { region, line: lines.line, text: lines.text }, height: fixed + region };
  })() : undefined;
  const bandHeight = capped ? capped.height : geometry?.height;

  // VoiceOver hears the band's title once when the band arrives on an open screen, as a sighted person sees it arrive.
  // Not when the screen opens with the band already there, where it's read in order, nor when it leaves or changes.
  // Queued, so the layout change the host posts as the band arrives doesn't cut it off. The screen counts as shown
  // without the band only while there's no problem at all, not while a band waits to be measured.
  const seenWithout = useRef(false);
  const sent = record?.sent;
  useEffect(() => {
    if (!ready || !opened) { seenWithout.current = false; return; }
    if (!syncProblem) { seenWithout.current = true; return; }
    if (!shownProblem || !seenWithout.current) return;
    seenWithout.current = false;
    AccessibilityInfo.announceForAccessibilityWithOptions(syncStatusWords[shownProblem], { queue: true });
    sent?.(syncStatusWords[shownProblem]);
  }, [ready, opened, syncProblem, shownProblem, sent]);

  const recordSpace = record?.space;
  const onSpace = useCallback((event: { nativeEvent: { height: number } }) => {
    setSpace(event.nativeEvent.height);
    recordSpace?.(event.nativeEvent.height);
  }, [recordSpace]);

  const band = ready && shownProblem ? (
    nativeBarBand
      ? <View testID="sync-band-area" style={[styles.band, { height: bandHeight }]}>
        <SyncBand problem={shownProblem} lines={capped?.lines} />
      </View>
      : <Animated.View testID="sync-band-area" style={[styles.band, { height: bandHeight, transform: [{ translateY: barBottom }] }]}>
        <SyncBand problem={shownProblem} />
      </Animated.View>
  ) : null;
  const measurers = (
    <>
      {heightNow === undefined ? (
        <View style={styles.measure} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
          onLayout={event => setMeasured({ problem: toMeasure, size, height: event.nativeEvent.layout.height })}>
          <SyncBand problem={toMeasure} />
        </View>
      ) : null}
      {/* Keyed, so a new problem or size starts its measures afresh rather than mixing them with the last ones. */}
      {linesNow === null ? (
        <View key={`${toMeasure}:${size}`} style={styles.measure} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <SyncBand problem={toMeasure} onLinesLayout={layout => setLinesMeasured({ problem: toMeasure, size, layout })} />
        </View>
      ) : null}
    </>
  );
  return {
    problem: shownProblem,
    bandHeight,
    coverHeight: nativeBarBand && ready && shownProblem ? bandHeight ?? 0 : 0,
    spacer: shownProblem !== null && !nativeBarBand,
    onSpace,
    scrollHandlers,
    band,
    measurers,
  };
}

/** The band's arrival, leaving or change of problem waits while a finger is on the list, still or dragging, or the list
 * still moves on its own, so content never jumps under a finger. It applies when the list settles. */
function useHeldWhileScrolling(latest: SyncProblem | null, mark?: (step: "released" | "applied") => void) {
  const [problem, setProblem] = useState(latest);
  const applied = useRef(latest);
  const moving = useRef({ touch: false, drag: false, momentum: false });
  const settle = useCallback(() => {
    if (moving.current.touch || moving.current.drag || moving.current.momentum || applied.current === latest) return;
    applied.current = latest;
    setProblem(latest);
    mark?.("applied");
  }, [latest, mark]);
  useEffect(settle, [settle]);
  // The hold ends when the last finger lifts, not the first.
  const lifted = useCallback((event: GestureResponderEvent) => {
    moving.current.touch = event.nativeEvent.touches.length > 0;
    if (moving.current.touch) return;
    mark?.("released");
    settle();
  }, [settle, mark]);
  const scrollHandlers = useMemo(() => ({
    onTouchStart: () => { moving.current.touch = true; },
    onTouchEnd: lifted,
    onTouchCancel: lifted,
    onScrollBeginDrag: () => { moving.current.drag = true; },
    onScrollEndDrag: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      moving.current.drag = false;
      // With no speed left, no momentum follows, so the list has settled.
      if (!event.nativeEvent.velocity?.y) settle();
    },
    onMomentumScrollBegin: () => { moving.current.momentum = true; },
    onMomentumScrollEnd: () => { moving.current.momentum = false; settle(); },
  }), [lifted, settle]);
  return { problem, scrollHandlers };
}

/** What the band is drawn from: its whole height and, on iOS, its capped form's measures, for one problem and size. */
type BandGeometry = { problem: SyncProblem; height: number; lines: BandLinesLayout | undefined };

const styles = StyleSheet.create({
  band: { position: "absolute", left: 0, right: 0, top: 0, overflow: "hidden" },
  measure: { position: "absolute", left: 0, right: 0, top: 0, opacity: 0 },
});
