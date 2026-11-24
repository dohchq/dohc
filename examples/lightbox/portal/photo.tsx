import { useEffect, useRef, useState } from "react";
import { useApp } from "dohc/app";
import { acquirePhotoFileUrl, errorMessage, type PhotoSource } from "./api";
import { sceneUrl } from "./scenes";

export interface FileAccess {
  readonly operation: string;
  input(photo: PhotoSource): Record<string, unknown>;
}

export function Photo({
  photo,
  access,
  size,
  className,
}: {
  photo: PhotoSource & { readonly mimeType?: string };
  access: FileAccess;
  size: "thumb" | "full";
  className?: string;
}) {
  const client = useApp();
  const placeholder = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(size === "full" || typeof IntersectionObserver === "undefined");
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ key: string; url?: string; error?: string }>({ key: "" });
  const key = `${photo.id}:${photo.fileId ?? photo.demoScene}:${size}`;
  const fileInput = JSON.stringify(access.input(photo));

  useEffect(() => {
    if (visible) return;
    const node = placeholder.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let current = true;
    const lease = photo.fileId
      ? acquirePhotoFileUrl(
          client,
          photo.fileId,
          access.operation,
          JSON.parse(fileInput),
          photo.mimeType ?? "image/jpeg",
          size === "full" ? "high" : "low",
        )
      : null;
    const pending = lease
      ? lease.promise
      : sceneUrl(photo.demoScene ?? "coast:1", photo.width, photo.height, size === "thumb" ? 720 : 2200);
    pending.then(
      (url) => current && setState({ key, url }),
      (error: unknown) => current && setState({ key, error: errorMessage(error) }),
    );
    return () => {
      current = false;
      lease?.release();
    };
  }, [visible, retry, client, key, access.operation, fileInput, photo.fileId, photo.demoScene, photo.width, photo.height, photo.mimeType, size]);

  const ready = state.key === key ? state : { key };
  if (ready.error)
    return (
      <div className={`lb-photo lb-photo-error ${className ?? ""}`} role="img" aria-label={`${photo.title} couldn't load`}>
        <span>{ready.error}</span>
        <span
          role="button"
          tabIndex={0}
          className="lb-photo-retry"
          onClick={(event) => {
            event.stopPropagation();
            setState({ key: "" });
            setRetry((count) => count + 1);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            setState({ key: "" });
            setRetry((count) => count + 1);
          }}
        >
          Try again
        </span>
      </div>
    );
  if (!ready.url) return <div ref={placeholder} className={`lb-photo lb-photo-loading ${className ?? ""}`} aria-hidden="true" />;
  return <img className={`lb-photo ${className ?? ""}`} src={ready.url} alt={photo.title} draggable={false} />;
}
