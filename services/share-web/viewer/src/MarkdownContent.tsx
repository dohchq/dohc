import {
  useLayoutEffect,
  useMemo,
  useRef,
  type MouseEvent,
  type SyntheticEvent,
} from "react";
import { renderSafeMarkdown } from "./markdown";
import {
  RETRY_BUDGET_MS,
  RETRY_INITIAL_MS,
  RETRY_MAX_MS,
} from "./retry";

interface ImageRetryState {
  source: string;
  retryDelayMs: number;
  retryWaitedMs: number;
  timeoutId: number | null;
  stopped: boolean;
}

export function MarkdownContent(props: {
  markdown: string;
  resolveImage?: (href: string) => string | null;
  resolveLink?: (href: string) => string | null;
  onNavigate?: (path: string) => void;
}) {
  const html = useMemo(
    () => renderSafeMarkdown(props.markdown, props.resolveImage, props.resolveLink),
    [props.markdown, props.resolveImage, props.resolveLink],
  );
  const imageRetries = useRef(new Map<HTMLImageElement, ImageRetryState>());
  useLayoutEffect(() => {
    const retries = imageRetries.current;
    return () => {
      for (const retry of retries.values()) {
        retry.stopped = true;
        if (retry.timeoutId !== null) window.clearTimeout(retry.timeoutId);
      }
      retries.clear();
    };
  }, [html]);

  const retryImage = (event: SyntheticEvent<HTMLElement>) => {
    if (!(event.target instanceof HTMLImageElement)) return;
    const image = event.target;
    let retry = imageRetries.current.get(image);
    if (!retry) {
      const source = image.getAttribute("src");
      if (!source) return;
      retry = {
        source,
        retryDelayMs: RETRY_INITIAL_MS,
        retryWaitedMs: 0,
        timeoutId: null,
        stopped: false,
      };
      imageRetries.current.set(image, retry);
    }
    if (retry.stopped || retry.timeoutId !== null) return;
    if (retry.retryWaitedMs + retry.retryDelayMs > RETRY_BUDGET_MS) {
      retry.stopped = true;
      return;
    }
    const retryDelayMs = retry.retryDelayMs;
    retry.timeoutId = window.setTimeout(() => {
      retry.timeoutId = null;
      if (retry.stopped) return;
      retry.retryWaitedMs += retryDelayMs;
      retry.retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
      image.src = retry.source;
    }, retryDelayMs);
  };
  const stopImageRetry = (event: SyntheticEvent<HTMLElement>) => {
    if (!(event.target instanceof HTMLImageElement)) return;
    const retry = imageRetries.current.get(event.target);
    if (!retry) return;
    retry.stopped = true;
    if (retry.timeoutId !== null) window.clearTimeout(retry.timeoutId);
    retry.timeoutId = null;
  };
  const navigate = (event: MouseEvent<HTMLElement>) => {
    if (!props.resolveLink || !props.onNavigate || !(event.target instanceof Element)) {
      return;
    }
    const anchor = event.target.closest("a");
    const href = anchor?.getAttribute("href");
    if (!href) return;
    const path = props.resolveLink(href);
    if (!path) return;
    event.preventDefault();
    props.onNavigate(path);
  };
  return (
    <article
      className="markdown"
      onClick={navigate}
      onErrorCapture={retryImage}
      onLoadCapture={stopImageRetry}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
