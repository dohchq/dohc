import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EngineMomentRecord } from "../../../src/ipc/bridgeContract";
import { EngineHistoryView } from "../../../src/renderer/workbench/EngineHistory";
import "./styles.css";

const initialMoments: EngineMomentRecord[] = Array.from({ length: 5000 }, (_, index) => ({
  id: `moment-${index}`,
  versionId: "main",
  path: `notes/file-${index}.md`,
  recordedAtMs: new Date(2026, 8, 17, 12).getTime() - index * 600_000,
  operation: "write",
  origin: "local-file",
  momentOrder: 5000 - index,
  ...(index % 10 < 3 ? {
    correlationId: `batch-${Math.floor(index / 10)}`,
    summary: "Updated project notes",
  } : {}),
}));

function HistoryFixture() {
  const [moments, setMoments] = useState(initialMoments);
  const [hasMore, setHasMore] = useState(true);
  const [opened, setOpened] = useState("");
  const [callbackGeneration, setCallbackGeneration] = useState(0);
  const onOpenMoment = useCallback((momentId: string) => {
    setOpened(callbackGeneration === 0 ? momentId : `${callbackGeneration}:${momentId}`);
  }, [callbackGeneration]);
  return (
    <main className="flex h-screen flex-col bg-panel text-ink">
      <output aria-label="Opened moment">{opened}</output>
      <button type="button" onClick={() => setCallbackGeneration((current) => current + 1)}>
        Replace open callback
      </button>
      <EngineHistoryView
        moments={moments}
        hasMore={hasMore}
        loadingMore={false}
        protectedTruncated
        onOpenMoment={onOpenMoment}
        onLoadMore={() => {
          setMoments((current) => [...current, {
            ...initialMoments[initialMoments.length - 1],
            id: "earlier-moment",
            path: "notes/earlier.md",
            recordedAtMs: initialMoments[initialMoments.length - 1].recordedAtMs - 600_000,
          }]);
          setHasMore(false);
        }}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<HistoryFixture />);
