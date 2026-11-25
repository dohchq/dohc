import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { useApp } from "dohc/app";
import { acquirePhotoFileUrl, errorMessage, type PhotoSource } from "./api";
import { sceneUrl } from "./scenes";

export function useSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

export function fit(photo: PhotoSource, box: { width: number; height: number }) {
  const ratio = photo.width / photo.height;
  const width = Math.max(0, Math.min(box.width, box.height * ratio));
  return { width, height: width / ratio };
}

export interface FileAccess {
  readonly operation: string;
  readonly fullSize: boolean;
  input(photo: PhotoSource): Record<string, unknown>;
}

type Viewable = PhotoSource & { readonly mimeType?: string };

export function usePhotoUrl(
  photo: Viewable,
  access: FileAccess,
  size: "thumb" | "full",
  visible = true,
) {
  const client = useApp();
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ key: string; url?: string; error?: string }>({ key: "" });
  const key = `${photo.id}:${photo.fileId ?? photo.demoScene}:${size}:${retry}`;
  const preview = Boolean(photo.previewFileId) && (size === "thumb" || !access.fullSize);
  const fileId = preview ? photo.previewFileId : photo.fileId;
  const fileInput = JSON.stringify(
    preview ? { ...access.input(photo), preview: true } : access.input(photo),
  );

  useEffect(() => {
    if (!visible) return;
    let current = true;
    const lease = fileId
      ? acquirePhotoFileUrl(
          client,
          fileId,
          access.operation,
          JSON.parse(fileInput),
          preview ? "image/jpeg" : (photo.mimeType ?? "image/jpeg"),
          size === "full" ? "high" : "low",
        )
      : null;
    const pending = lease
      ? lease.promise
      : sceneUrl(
          photo.demoScene ?? "village:1",
          photo.width,
          photo.height,
          size === "thumb" ? 720 : 2200,
        );
    pending.then(
      (url) => current && setState({ key, url }),
      (error: unknown) => current && setState({ key, error: errorMessage(error) }),
    );
    return () => {
      current = false;
      lease?.release();
      setState((value) => (value.key === key ? { key: "" } : value));
    };
  }, [
    visible,
    client,
    key,
    access.operation,
    fileInput,
    fileId,
    preview,
    photo.demoScene,
    photo.width,
    photo.height,
    photo.mimeType,
    size,
  ]);

  const ready = state.key === key ? state : { key };
  return { url: ready.url, error: ready.error, retry: () => setRetry((count) => count + 1) };
}

export function Photo({
  photo,
  access,
  size,
  className,
}: {
  photo: Viewable;
  access: FileAccess;
  size: "thumb" | "full";
  className?: string;
}) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const watch = size === "thumb" && typeof IntersectionObserver !== "undefined";
  const [visible, setVisible] = useState(!watch);
  const ready = usePhotoUrl(photo, access, size, visible);

  useEffect(() => {
    if (!watch || !node) return;
    const root = node.parentElement?.closest("[data-scroll-root]") ?? document;
    const seen = (entries: IntersectionObserverEntry[]) =>
      entries.some((entry) => entry.isIntersecting);
    const near = new IntersectionObserver(
      (entries) => {
        if (seen(entries)) setVisible(true);
      },
      { root, rootMargin: "150%" },
    );
    const far = new IntersectionObserver(
      (entries) => {
        if (!seen(entries)) setVisible(false);
      },
      { root, rootMargin: "400%" },
    );
    near.observe(node);
    far.observe(node);
    return () => {
      near.disconnect();
      far.disconnect();
    };
  }, [watch, node]);

  if (ready.error)
    return (
      <div ref={setNode} className={`lb-photo lb-photo-error ${className ?? ""}`}>
        <span role="img" aria-label={`${photo.title} could not load`}>
          {ready.error}
        </span>
        {size === "full" ? (
          <button
            type="button"
            className="lb-photo-retry"
            aria-label={`Try loading ${photo.title} again`}
            onClick={(event) => {
              event.stopPropagation();
              ready.retry();
            }}
          >
            Try again
          </button>
        ) : null}
      </div>
    );
  if (!ready.url)
    return (
      <div
        ref={setNode}
        className={`lb-photo lb-photo-loading ${className ?? ""}`}
        aria-hidden="true"
      />
    );
  return (
    <img
      ref={setNode}
      className={`lb-photo ${className ?? ""}`}
      src={ready.url}
      alt={photo.title}
      draggable={false}
      decoding="async"
    />
  );
}
