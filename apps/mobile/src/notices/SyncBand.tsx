import { noticesWords, phoneSyncBody, syncStatusWords } from "@dohc/interface-words/notices";
import { AlertTriangle } from "lucide-react-native";
import { useRef, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View, type ScrollViewInstance } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { ActionPill } from "./ActionPill";
import { useTheme } from "../theme";

export type SyncProblem = keyof typeof phoneSyncBody;

/** Where a band taller than its cap draws its words: a region of whole lines, one line tall each, and the words' height. */
export type BandLines = { region: number; line: number; text: number };

/** The capped form's measures, from a hidden copy: the band's whole height, its words' height, and one line. */
export type BandLinesLayout = { total: number; text: number; line: number };

// Only when the whole workspace can't sync: one band at the top, with the desktop's title and the phone's body.
//
// Capped, at the largest text sizes, the title and body scroll inside a region of whole lines, a line at a time, so a
// line is never cut at rest; a fade at the bottom shows there's more while there is, and the indicator flashes as the
// band arrives. Try again stays below the region, always in view. VoiceOver reads the words whole, as one element.
export function SyncBand({ problem, lines, onLinesLayout }: {
  problem: SyncProblem;
  /** Draw the capped form in a region of whole lines. */
  lines?: BandLines;
  /** Draw the capped form at full height and report its measures (the hidden copy). */
  onLinesLayout?(layout: BandLinesLayout): void;
}) {
  const theme = useTheme();
  const retry = problem === "serverUnreachable" || problem === "syncFailed";
  const title = syncStatusWords[problem], body = phoneSyncBody[problem];
  const action = retry ? <View style={styles.action}><ActionPill label={noticesWords.tryAgain} /></View> : null;
  const capped = lines !== undefined || onLinesLayout !== undefined;
  const measures = useRef<{ total?: number; text?: number; line?: number }>({});
  const report = (key: "total" | "text" | "line", value: number) => {
    measures.current[key] = value;
    const { total, text, line } = measures.current;
    if (onLinesLayout && total !== undefined && text !== undefined && line !== undefined) onLinesLayout({ total, text, line });
  };
  const words = (
    <Text style={[styles.lines, { color: theme.muted }]} accessible accessibilityLabel={`${title}. ${body}`}
      onLayout={onLinesLayout ? event => report("text", event.nativeEvent.layout.height) : undefined}
      onTextLayout={onLinesLayout ? event => { const first = event.nativeEvent.lines[0]; if (first) report("line", first.height); } : undefined}>
      <Text style={[styles.linesTitle, { color: theme.ink }]}>{title}</Text>
      {"\n"}{body}
    </Text>
  );
  return (
    <View style={[styles.band, { backgroundColor: theme.panel2, borderBottomColor: theme.line }]} accessibilityRole="alert" testID="sync-band"
      onLayout={onLinesLayout ? event => report("total", event.nativeEvent.layout.height) : undefined}>
      <AlertTriangle size={18} color={theme.danger} strokeWidth={2} />
      <View style={styles.main}>
        {!capped ? (
          <>
            <Text style={[styles.title, { color: theme.ink }]}>{title}</Text>
            <Text style={[styles.body, { color: theme.muted }]}>{body}</Text>
          </>
        ) : lines ? <BandRegion lines={lines} fade={theme.panel2}>{words}</BandRegion> : words}
        {action}
      </View>
    </View>
  );
}

/** The capped band's words, scrolling a line at a time in a region of whole lines. */
function BandRegion({ lines, fade, children }: { lines: BandLines; fade: string; children: ReactNode }) {
  const scroll = useRef<ScrollViewInstance>(null);
  // The fade shows while words remain below the region: from the measured words before any scroll, so words that fit
  // never show it, and from the scroll position after.
  const offset = useRef(0);
  const [atEnd, setAtEnd] = useState(false);
  const more = !atEnd && lines.text > lines.region + 0.5;
  return (
    // The line's height is in the identifier, so a test can check that every rest is on a line.
    <View style={{ height: lines.region }} testID={`sync-band-words:${lines.line}`}>
      <ScrollView ref={scroll} bounces={false} snapToInterval={lines.line} decelerationRate="fast" scrollEventThrottle={16}
        onLayout={() => scroll.current?.flashScrollIndicators()}
        onContentSizeChange={(_, height) => setAtEnd(offset.current + lines.region >= height - 0.5)}
        onScroll={event => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          offset.current = contentOffset.y;
          setAtEnd(contentOffset.y + layoutMeasurement.height >= contentSize.height - 0.5);
        }}>
        {children}
      </ScrollView>
      {more ? (
        <Svg width="100%" height={Math.min(lines.line, 24)} style={styles.fade} pointerEvents="none">
          <Defs>
            <LinearGradient id="band-fade" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={fade} stopOpacity="0" />
              <Stop offset="1" stopColor={fade} stopOpacity="1" />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#band-fade)" />
        </Svg>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  band: { flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  main: { flex: 1, gap: 3 },
  title: { fontSize: 15, fontWeight: "600" },
  body: { fontSize: 14, lineHeight: 19 },
  action: { flexDirection: "row", marginTop: 6 },
  // The capped form: the title and body as one text with one line height, so its lines sit on one grid.
  lines: { fontSize: 14, lineHeight: 19 },
  linesTitle: { fontSize: 15, fontWeight: "600", lineHeight: 19 },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0 },
});
