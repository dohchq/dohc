import { setTimeout as delay } from "node:timers/promises";

export const QUEUED_STATUSES = ["queued", "waiting", "pending", "requested"];
export const CLOUD_POLL_MS = 2_500;
export const GATE_POLL_MS = { js: 3_000, rust: 10_000 };

export function cloudApi({ env = process.env, request = fetch, pause = delay, now = Date.now, deadline = Infinity } = {}) {
  const base = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const cache = new Map();
  let last, counted = 0, unchanged = 0;
  return {
    pollMs: CLOUD_POLL_MS,
    async read(path, { conditional = false } = {}) {
      const previous = conditional ? cache.get(path) : undefined;
      let cause, attempts = 0;
      const failed = () => new Error(`Cannot read workflow ${path}: ${cause?.message ?? "deadline reached"} after ${attempts} attempt${attempts === 1 ? "" : "s"}.`, { cause });
      while (now() < deadline) {
        attempts++;
        let response;
        try {
          response = await request(base + path, {
            headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
              ...(previous?.etag ? { "If-None-Match": previous.etag } : {}) },
            signal: AbortSignal.timeout(Math.min(10_000, deadline - now())),
          });
        } catch (error) { cause = error; }
        if (response) {
          last = response.headers;
          if (response.status === 304) {
            unchanged++;
            if (!previous) throw new Error("Conditional workflow response has no cached data.");
            return previous.data;
          }
          counted++;
          if (response.ok) {
            try {
              const data = await response.json();
              if (conditional && previous && JSON.stringify(data) === JSON.stringify(previous.data)) this.pollMs = 10_000;
              if (conditional) cache.set(path, { etag: last?.get("etag"), data });
              return data;
            } catch (error) { cause = error; }
          } else {
            cause = new Error(`HTTP ${response.status}`);
            await response.body?.cancel().catch(() => {});
            if (response.status !== 429 && (response.status < 500 || response.status >= 600)) throw failed();
          }
        }
        if (attempts === 3 || now() >= deadline) throw failed();
        await pause(Math.min(1_000, deadline - now()));
      }
      throw failed();
    },
    async download(id, headersTimeoutMs, remainingMs) {
      const headersDeadline = new AbortController();
      const timer = setTimeout(() => headersDeadline.abort(new Error("Artifact download readiness timed out.")), headersTimeoutMs);
      let response;
      try {
        response = await request(`${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`, {
          headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
          signal: AbortSignal.any([headersDeadline.signal, AbortSignal.timeout(Math.min(60_000, remainingMs))]),
        });
      } finally { clearTimeout(timer); }
      counted++;
      // Redirected blob responses have no REST rate-limit headers.
      if (response.headers.has("x-ratelimit-limit")) last = response.headers;
      return response;
    },
    async jobs() {
      const result = [];
      for (let page = 1; ; page++) {
        const data = await this.read(`/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100&page=${page}`);
        if (!Array.isArray(data.jobs)) throw new Error("Missing workflow jobs.");
        result.push(...data.jobs);
        if (data.jobs.length < 100) return result;
      }
    },
    log(label) {
      console.log(`[verification] REST ${label}: ${["limit", "remaining", "used"].map(key =>
        `x-ratelimit-${key}=${last?.get(`x-ratelimit-${key}`) ?? "unknown"}`).join(" ")} counted=${counted} 304=${unchanged}`);
    },
  };
}
