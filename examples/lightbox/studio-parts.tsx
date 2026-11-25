import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Star } from "dohc/icons";
import {
  COLOR_LABELS,
  type ColorLabel,
  type PhotoSource,
  type Shoot,
  type StudioAsset,
} from "./portal/api";
import { usePhotoUrl, type FileAccess } from "./portal/photo";

export const STUDIO_FILES: FileAccess = {
  operation: "studioFileAccess",
  fullSize: true,
  input: (photo) => ({ assetId: photo.id }),
};
export const STATUS_TEXT: Record<Shoot["status"], string> = {
  draft: "Draft",
  proofing: "Proofing",
  delivered: "Delivered",
};
export const LABEL_KEYS: Record<string, ColorLabel> = {
  "6": "red",
  "7": "yellow",
  "8": "green",
  "9": "blue",
};
export const LABEL_TITLES: Record<ColorLabel, string> = {
  none: "No label",
  red: "Red",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
};

export const UNDO_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘Z" : "Ctrl+Z";
export const BATCH = 100;

export type Mode = "grid" | "loupe" | "compare";
export type Library = "all" | "picks" | "annotated" | "drafts";
export type ZoomLevel = "fit" | 1 | 2;

export interface Zoom {
  readonly level: ZoomLevel;
  readonly x: number;
  readonly y: number;
}

export const FIT: Zoom = { level: "fit", x: 0.5, y: 0.5 };

const WIDE = "(min-width: 961px)";

export function wideScreen() {
  try {
    return window.matchMedia(WIDE).matches;
  } catch {
    return true;
  }
}

export function useWide() {
  const [wide, setWide] = useState(wideScreen);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const update = () => setWide(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return wide;
}

export function names(list: readonly StudioAsset[]) {
  return list.length === 1 ? list[0]!.title : plural(list.length, "photo");
}

export function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export function formatCode(code: string) {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

export function fileName(asset: StudioAsset) {
  const kind =
    asset.mimeType === "image/png" ? "png" : asset.mimeType === "image/webp" ? "webp" : "jpg";
  return `${asset.title}.${kind}`;
}

export function aspect(photo: PhotoSource) {
  const divisor = (a: number, b: number): number => (b ? divisor(b, a % b) : a);
  const common = divisor(photo.width, photo.height);
  const wide = photo.width / common;
  const tall = photo.height / common;
  return wide <= 21 && tall <= 21 ? `${wide}:${tall}` : (photo.width / photo.height).toFixed(2);
}

export function StatusMark({ status }: { status: Shoot["status"] }) {
  return <span className={`st-status st-status-${status}`} aria-hidden="true" />;
}

export function LabelMark({ label, size = 10 }: { label: ColorLabel; size?: number }) {
  if (label === "none") return null;
  return (
    <span
      className={`st-label st-label-${label}`}
      style={{ width: size, height: size }}
      title={`${LABEL_TITLES[label]} label`}
    />
  );
}

export function Rating({ value, quiet = false }: { value: number; quiet?: boolean }) {
  if (quiet && !value) return null;
  return (
    <span className="st-rating" aria-label={value ? `${value} of 5 stars` : "Unrated"}>
      {[1, 2, 3, 4, 5].map((star) => (
        <span key={star} className={star <= value ? "st-rating-on" : undefined} aria-hidden="true">
          {star <= value ? "★" : "·"}
        </span>
      ))}
    </span>
  );
}

export function StarInput({
  value,
  onChange,
  label = "Rating",
  id,
}: {
  value: number | null;
  onChange(value: number): void;
  label?: string;
  id?: string;
}) {
  return (
    <div className="st-stars" role="radiogroup" aria-label={label} id={id}>
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          role="radio"
          aria-checked={value === star}
          aria-label={plural(star, "star")}
          title={`${plural(star, "star")} (${star})`}
          className={star <= (value ?? 0) ? "st-star-on" : undefined}
          onClick={() => onChange(value === star ? 0 : star)}
        >
          <Star size={15} strokeWidth={1.6} fill={star <= (value ?? 0) ? "currentColor" : "none"} />
        </button>
      ))}
    </div>
  );
}

export function LabelInput({
  value,
  onChange,
  label = "Color label",
}: {
  value: ColorLabel | null;
  onChange(value: ColorLabel): void;
  label?: string;
}) {
  return (
    <div className="st-labels" role="radiogroup" aria-label={label}>
      {COLOR_LABELS.map((color, position) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={LABEL_TITLES[color]}
          title={position < 4 ? `${LABEL_TITLES[color]} (${position + 6})` : LABEL_TITLES[color]}
          className={`st-label-button${value === color ? " st-label-on" : ""}`}
          onClick={() => onChange(value === color ? "none" : color)}
        >
          <span className={`st-label st-label-${color}`} />
        </button>
      ))}
    </div>
  );
}

export function Section({
  title,
  action,
  children,
  open: initial = true,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initial);
  return (
    <section className={`st-section${open ? "" : " st-section-closed"}`}>
      <header className="st-section-head">
        <button
          type="button"
          className="st-section-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? (
            <ChevronDown size={12} strokeWidth={2} />
          ) : (
            <ChevronRight size={12} strokeWidth={2} />
          )}
          <span>{title}</span>
        </button>
        {action}
      </header>
      {open ? <div className="st-section-body">{children}</div> : null}
    </section>
  );
}

const BINS = 64;

function histogramPath(bins: readonly number[], peak: number) {
  const points = bins.map(
    (count, index) => `${index + 0.5},${(100 - Math.min(100, (count / peak) * 96)).toFixed(2)}`,
  );
  return `M0,100 L${points.join(" L")} L${BINS},100 Z`;
}

export function Histogram({ photo, access }: { photo: StudioAsset; access: FileAccess }) {
  const { url } = usePhotoUrl(photo, access, "thumb");
  const [data, setData] = useState<{
    url: string;
    channels: number[][];
    clipped: [boolean, boolean];
  } | null>(null);
  useEffect(() => {
    if (!url) return;
    let current = true;
    const image = new Image();
    image.onload = () => {
      if (!current) return;
      const scale = Math.min(1, 220 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const channels = [
        new Array<number>(BINS).fill(0),
        new Array<number>(BINS).fill(0),
        new Array<number>(BINS).fill(0),
      ];
      let low = 0;
      let high = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index]!;
        const green = pixels[index + 1]!;
        const blue = pixels[index + 2]!;
        channels[0]![red >> 2]!++;
        channels[1]![green >> 2]!++;
        channels[2]![blue >> 2]!++;
        if (red < 3 && green < 3 && blue < 3) low++;
        if (red > 252 && green > 252 && blue > 252) high++;
      }
      const total = pixels.length / 4;
      setData({ url, channels, clipped: [low / total > 0.004, high / total > 0.004] });
    };
    image.src = url;
    return () => {
      current = false;
    };
  }, [url]);
  const ready = data && data.url === url ? data : null;
  const peak = ready
    ? Math.max(1, ...ready.channels.flatMap((channel) => channel.slice(2, BINS - 2)))
    : 1;
  return (
    <div className="st-histogram" role="img" aria-label={`Histogram of ${photo.title}`}>
      {ready ? (
        <svg viewBox={`0 0 ${BINS} 100`} preserveAspectRatio="none" aria-hidden="true">
          <path d={histogramPath(ready.channels[0]!, peak)} className="st-hist-r" />
          <path d={histogramPath(ready.channels[1]!, peak)} className="st-hist-g" />
          <path d={histogramPath(ready.channels[2]!, peak)} className="st-hist-b" />
        </svg>
      ) : null}
      <span
        className={`st-clip st-clip-low${ready?.clipped[0] ? " st-clip-on" : ""}`}
        title="Shadow clipping"
      />
      <span
        className={`st-clip st-clip-high${ready?.clipped[1] ? " st-clip-on" : ""}`}
        title="Highlight clipping"
      />
    </div>
  );
}
