import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { useApp } from "dohc/app";
import { reconstructReplayFrames } from "./replay";
import type { ReplayPayload } from "./types";

const STEP_MS = 850;

export function useReplay(client: ReturnType<typeof useApp>) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ReplayPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const requestSeq = useRef(0);

  useEffect(() => {
    return () => {
      requestSeq.current += 1;
    };
  }, []);

  const frames = useMemo(() => (data ? reconstructReplayFrames(data) : []), [data]);
  const lastStep = frames.length - 1;

  const running = playing && open && step < lastStep;

  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => setStep((current) => current + 1), STEP_MS);
    return () => window.clearTimeout(timer);
  }, [running, step]);

  const cancel = useCallback(() => {
    requestSeq.current += 1;
    setLoading(false);
    setError(null);
    setPlaying(false);
  }, []);

  const close = useCallback(() => {
    cancel();
    setOpen(false);
  }, [cancel]);

  const reset = useCallback(() => {
    close();
    setData(null);
  }, [close]);

  const load = useCallback(
    async (gameId: string): Promise<boolean> => {
      const requestId = ++requestSeq.current;
      setLoading(true);
      setError(null);
      setPlaying(false);
      try {
        const firstPage = await client.read<ReplayPayload>("replayGame", { gameId, afterTurn: 0, limit: 200 });
        if (requestSeq.current !== requestId) return false;
        const allMoves = [...firstPage.moves];
        let cursor = firstPage.nextAfterTurn;
        while (cursor !== null) {
          const nextPage = await client.read<ReplayPayload>("replayGame", { gameId, afterTurn: cursor, limit: 200 });
          if (requestSeq.current !== requestId) return false;
          allMoves.push(...nextPage.moves);
          cursor = nextPage.nextAfterTurn;
        }
        setData({ ...firstPage, moves: allMoves, nextAfterTurn: null });
        setStep(0);
        setOpen(true);
        return true;
      } catch (caught) {
        if (requestSeq.current === requestId) setError(caught instanceof Error ? caught.message : "dohc could not load the replay.");
        return false;
      } finally {
        if (requestSeq.current === requestId) setLoading(false);
      }
    },
    [client],
  );

  const goTo = useCallback(
    (index: number) => {
      setPlaying(false);
      setStep(Math.max(0, Math.min(lastStep, index)));
    },
    [lastStep],
  );

  const togglePlay = useCallback(() => {
    if (!running && step >= lastStep) setStep(0);
    setPlaying(!running);
  }, [lastStep, running, step]);

  const activeFrame = open && frames.length > 0 ? (frames[Math.min(step, lastStep)] ?? null) : null;

  return { open, data, loading, error, step, playing: running, frames, activeFrame, load, close, reset, goTo, togglePlay };
}
