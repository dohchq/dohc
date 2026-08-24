import { useEffect, type DependencyList } from "react";

export interface AsyncResponseHandlers<T> {
  onSuccess: (value: T) => void;
  onError: (error: unknown) => void;
}

/**
 * Starts one request for one effect identity. A replaced or unmounted effect
 * cannot commit either answer. This does not abort or order the request, and
 * it does not validate any workspace, event, or protocol identity. The
 * dependencies must contain every value read by the request and by either
 * commit handler, including every value that defines the response identity.
 */
export function useAsyncResponseEffect<T>(
  request: () => Promise<T> | null,
  handlers: AsyncResponseHandlers<T>,
  dependencies: DependencyList,
): void {
  useEffect(() => {
    const response = request();
    if (response === null) return;
    let acceptsResponse = true;

    void response.then(
      (value) => {
        if (acceptsResponse) handlers.onSuccess(value);
      },
      (error: unknown) => {
        if (acceptsResponse) handlers.onError(error);
      },
    );
    return () => {
      acceptsResponse = false;
    };
  }, dependencies);
}
