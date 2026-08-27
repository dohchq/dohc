import { useCallback, useEffect, useRef, useState } from "react";

interface ActiveDrag<T> {
  pointerId: number;
  value: T;
}

// Keep pointer-rate previews inside the surface that paints them. Terminal
// pointer events and window blur publish the last preview once; unmount only
// drops it, so a keyed workspace remount cannot carry a drag across shells.
export function useCommitOnRelease<T>(onCommit: (value: T) => void) {
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const activeDrag = useRef<ActiveDrag<T> | null>(null);
  const [previewValue, setPreviewValue] = useState<T | null>(null);

  const commit = useCallback((pointerId?: number) => {
    const drag = activeDrag.current;
    if (drag === null || (pointerId !== undefined && drag.pointerId !== pointerId)) {
      return;
    }
    activeDrag.current = null;
    setPreviewValue(null);
    onCommitRef.current(drag.value);
  }, []);

  const begin = useCallback((pointerId: number, value: T) => {
    activeDrag.current = { pointerId, value };
    setPreviewValue(value);
  }, []);

  const update = useCallback(
    (pointerId: number, value: T, buttons: number) => {
      const drag = activeDrag.current;
      if (drag === null || drag.pointerId !== pointerId) return;
      drag.value = value;
      setPreviewValue(value);
      if ((buttons & 1) === 0) commit(pointerId);
    },
    [commit],
  );

  const isActive = useCallback(
    (pointerId: number) => activeDrag.current?.pointerId === pointerId,
    [],
  );

  useEffect(() => {
    const commitOnBlur = () => commit();
    window.addEventListener("blur", commitOnBlur);
    return () => window.removeEventListener("blur", commitOnBlur);
  }, [commit]);

  return { begin, commit, isActive, previewValue, update };
}
