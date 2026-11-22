import { Minus, Plus, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState, IconButton } from "./ui/controls";
import { SegmentedControl, type SegmentedOption } from "./ui/SegmentedControl";

type Backdrop = "checker" | "paper" | "dark";
type Zoom = "fit" | number;

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
const BACKDROP_OPTIONS: readonly SegmentedOption<Backdrop>[] = [
  { value: "checker", label: "Checker" },
  { value: "paper", label: "Paper" },
  { value: "dark", label: "Dark" },
];

const CHECKER_STYLE = {
  backgroundImage:
    "repeating-conic-gradient(color-mix(in srgb, var(--dohc-ink) 6%, transparent) 0 25%, transparent 0 50%)",
  backgroundSize: "16px 16px",
};

function stepZoom(current: number, direction: 1 | -1): number | null {
  if (direction > 0) {
    return ZOOM_STEPS.find((step) => step > current + 0.001) ?? null;
  }
  for (let index = ZOOM_STEPS.length - 1; index >= 0; index -= 1) {
    if (ZOOM_STEPS[index]! < current - 0.001) return ZOOM_STEPS[index]!;
  }
  return null;
}

export function ImageView({ url, path }: { url: string; path: string }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [fitScale, setFitScale] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [backdrop, setBackdrop] = useState<Backdrop>("checker");
  const [zoom, setZoom] = useState<Zoom>("fit");
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const prevUrlRef = useRef(url);
  const name = path.split("/").pop() ?? path;

  const measureFit = useCallback((w: number, h: number) => {
    if (w <= 0 || h <= 0) return;
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      setFitScale(null);
      return;
    }
    const scale = Math.min(rect.width / w, rect.height / h, 1);
    setFitScale(Number.isFinite(scale) && scale > 0 ? scale : null);
  }, []);

  useEffect(() => {
    if (prevUrlRef.current !== url) {
      prevUrlRef.current = url;
      setDims(null);
      setFitScale(null);
      setFailed(false);
      setZoom("fit");
    }
    const img = imgRef.current;
    if (img?.complete && img.naturalWidth > 0 && img.naturalHeight > 0) {
      setDims({ w: img.naturalWidth, h: img.naturalHeight });
      measureFit(img.naturalWidth, img.naturalHeight);
    }
  }, [url, measureFit]);

  useEffect(() => {
    if (zoom !== "fit" || !dims) return;
    const sync = () => measureFit(dims.w, dims.h);
    sync();
    const viewport = viewportRef.current;
    const img = imgRef.current;
    if ((!viewport && !img) || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    if (viewport) observer.observe(viewport);
    if (img) observer.observe(img);
    return () => observer.disconnect();
  }, [zoom, dims, measureFit]);

  const effectiveScale = zoom === "fit" ? (fitScale ?? 1) : zoom;
  const nextZoomIn = stepZoom(effectiveScale, 1);
  const nextZoomOut = stepZoom(effectiveScale, -1);

  const zoomIn = useCallback(() => {
    const base = zoom === "fit" ? (fitScale ?? 1) : zoom;
    const next = stepZoom(base, 1);
    if (next === null) return;
    if (stepZoom(next, 1) === null) viewportRef.current?.focus({ preventScroll: true });
    setZoom(next);
  }, [zoom, fitScale]);

  const zoomOut = useCallback(() => {
    const base = zoom === "fit" ? (fitScale ?? 1) : zoom;
    const next = stepZoom(base, -1);
    if (next === null) return;
    if (stepZoom(next, -1) === null) viewportRef.current?.focus({ preventScroll: true });
    setZoom(next);
  }, [zoom, fitScale]);

  const toggleFit = useCallback(() => setZoom((current) => (current === "fit" ? 1 : "fit")), []);

  const frameClass =
    backdrop === "paper" ? "bg-bg dark:bg-ink" : backdrop === "dark" ? "bg-ink dark:bg-bg" : "";
  const scaled = zoom !== "fit" && dims !== null;
  const imgStyle = scaled
    ? {
        width: Math.max(1, Math.round(dims.w * zoom)),
        height: Math.max(1, Math.round(dims.h * zoom)),
      }
    : undefined;
  const zoomLabel = zoom === "fit" ? "Fit" : `${Math.round(zoom * 100)}%`;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-bg"
      data-testid="view-image"
      onKeyDown={(event) => {
        if (failed || event.ctrlKey || event.metaKey || event.altKey) return;
        if (
          event.target instanceof Element &&
          event.target.closest(
            'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
          )
        ) {
          return;
        }
        if (event.key === "=" || event.key === "+") {
          event.preventDefault();
          zoomIn();
        } else if (event.key === "-") {
          event.preventDefault();
          zoomOut();
        } else if (event.key === "0") {
          event.preventDefault();
          setZoom("fit");
        }
      }}
    >
      <div
        ref={viewportRef}
        role="region"
        tabIndex={0}
        aria-label={`Image preview: ${name}`}
        style={{ containerType: "size" }}
        className="flex min-h-0 flex-1 overflow-auto p-6 focus-visible:-outline-offset-2"
        onWheel={(event) => {
          if (failed || !(event.ctrlKey || event.metaKey)) return;
          event.preventDefault();
          if (event.deltaY < 0) zoomIn();
          else if (event.deltaY > 0) zoomOut();
        }}
      >
        {failed ? (
          <EmptyState tone="danger" icon={TriangleAlert} title="dohc could not load this image." />
        ) : (
          <div
            data-testid="image-backdrop-frame"
            data-backdrop={backdrop}
            style={backdrop === "checker" ? CHECKER_STYLE : undefined}
            className={`m-auto flex min-h-12 min-w-12 items-center justify-center rounded border border-line p-2 ${frameClass}`}
          >
            <img
              ref={imgRef}
              src={url}
              alt={name}
              onClick={toggleFit}
              className={`block ${
                zoom === "fit"
                  ? "h-auto w-auto max-h-[calc(100cqh-1.25rem)] max-w-[calc(100cqw-1.25rem)] cursor-zoom-in"
                  : "max-w-none cursor-zoom-out"
              }`}
              style={imgStyle}
              onLoad={(e) => {
                const w = e.currentTarget.naturalWidth;
                const h = e.currentTarget.naturalHeight;
                setDims({ w, h });
                measureFit(w, h);
              }}
              onError={() => setFailed(true)}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line bg-panel px-4 py-1.5 text-[12px] text-subtle">
        <span className="min-w-0 truncate tabular-nums">
          {name}
          {dims ? ` · ${dims.w}×${dims.h}` : ""}
        </span>
        {!failed ? (
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex items-center gap-0.5" role="group" aria-label="Image zoom">
              <IconButton
                data-testid="image-zoom-out"
                aria-label="Zoom out"
                title="Zoom out (-)"
                disabled={nextZoomOut === null}
                onClick={zoomOut}
              >
                <Minus size={13} aria-hidden />
              </IconButton>
              <button
                type="button"
                data-testid="image-zoom-toggle"
                aria-label="Toggle fit and 100%"
                title={zoom === "fit" ? "Show at 100%" : "Fit to view (0)"}
                onClick={toggleFit}
                className="h-6 min-w-11 rounded-md px-1.5 text-center text-[12px] tabular-nums text-muted transition-colors hover:bg-hover hover:text-ink active:bg-selected"
              >
                {zoomLabel}
              </button>
              <IconButton
                data-testid="image-zoom-in"
                aria-label="Zoom in"
                title="Zoom in (+)"
                disabled={nextZoomIn === null}
                onClick={zoomIn}
              >
                <Plus size={13} aria-hidden />
              </IconButton>
            </div>
            <SegmentedControl
              label="Image backdrop"
              testId="image-backdrop"
              value={backdrop}
              options={BACKDROP_OPTIONS}
              onChange={setBackdrop}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
