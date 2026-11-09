import { File, Paths } from "expo-file-system";
import { useRouter } from "expo-router";
import { useEffect, type RefObject } from "react";
import { useFrameCallback, useSharedValue } from "react-native-reanimated";
import { demoMode } from "./demo";

// Design review only, on the first screen, for the design lead's launch numbers:
// - "delay-<ms>" opens a page that long after the first screen draws, timed from that moment.
// - "frames" scrolls the list from the first draw and records UI-thread frame intervals for 2 s, written to
//   frames.json: how smooth the first screen stays while WebKit starts.
const delay = /^delay-(\d+)$/.exec(demoMode ?? "")?.[1];

/** Whether the first screen's probe runs: only in its demos, so no other build creates its frame callback. */
export const firstScreenProbeOn = Boolean(delay) || demoMode === "frames";

interface Scrollable { scrollToOffset(options: { offset: number; animated?: boolean }): void }

/** Design review only; rendered only when `firstScreenProbeOn`. */
export function FirstScreenProbe({ list }: { list: RefObject<Scrollable | null> }) {
  useFirstScreenProbe(list);
  return null;
}

function useFirstScreenProbe(list: RefObject<Scrollable | null>) {
  const router = useRouter();
  const stats = useSharedValue({ frames: 0, over25: 0, over33: 0, max: 0, total: 0, stalls: [] as number[][] });
  const frames = useFrameCallback(info => {
    "worklet";
    const gap = info.timeSincePreviousFrame;
    if (gap === null) return;
    const s = stats.value;
    // Each frame over 25 ms, as [wall-clock ms at its end, its length], to line up with what else ran then.
    stats.value = { frames: s.frames + 1, over25: s.over25 + (gap > 25 ? 1 : 0), over33: s.over33 + (gap > 33 ? 1 : 0),
      max: Math.max(s.max, gap), total: s.total + gap, stalls: gap > 25 ? [...s.stalls, [Date.now(), Math.round(gap)]] : s.stalls };
  }, false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = 0;
    const first = requestAnimationFrame(() => {
      if (delay) {
        timer = setTimeout(() => router.push({ pathname: "/page", params: { path: "trip/packing-list.md", t0: String(Date.now()) } }), Number(delay));
        return;
      }
      started = Date.now();
      frames.setActive(true);
      list.current?.scrollToOffset({ offset: 700, animated: true });
      setTimeout(() => list.current?.scrollToOffset({ offset: 0, animated: true }), 900);
      timer = setTimeout(() => {
        frames.setActive(false);
        const s = stats.value;
        void new File(Paths.document, "frames.json").write(JSON.stringify({ ...s, started, mean: s.frames ? s.total / s.frames : 0 }));
      }, 2000);
    });
    return () => { cancelAnimationFrame(first); clearTimeout(timer); };
    // Once, at the first draw.
  }, []);
}

/** Design review only: records UI-thread frame intervals for 10 s from the first draw of Notices, written to
 * notices-frames.json. Rendered only in the demo "notices-frames", so no other build creates its frame callback. */
export function NoticesFrameProbe() {
  useNoticesFrameProbe();
  return null;
}

function useNoticesFrameProbe() {
  const stats = useSharedValue({ frames: 0, over25: 0, over33: 0, max: 0, total: 0 });
  const frames = useFrameCallback(info => {
    "worklet";
    const gap = info.timeSincePreviousFrame;
    if (gap === null) return;
    const s = stats.value;
    stats.value = { frames: s.frames + 1, over25: s.over25 + (gap > 25 ? 1 : 0), over33: s.over33 + (gap > 33 ? 1 : 0),
      max: Math.max(s.max, gap), total: s.total + gap };
  }, false);
  useEffect(() => {
    frames.setActive(true);
    const timer = setTimeout(() => {
      frames.setActive(false);
      const s = stats.value;
      void new File(Paths.document, "notices-frames.json").write(JSON.stringify({ ...s, mean: s.frames ? s.total / s.frames : 0 }));
    }, 10000);
    return () => clearTimeout(timer);
    // Once, at the first draw.
  }, []);
}
