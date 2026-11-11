export const QUEUED_STATUSES = ["queued", "waiting", "pending", "requested"];
export const CLOUD_POLL_MS = 2_500;
export const GATE_POLL_MS = { js: 3_000, rust: 10_000 };

export function cloudApi({ env = process.env, request = fetch } = {}) {
  const base = `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
  const cache = new Map();
  let last, counted = 0, unchanged = 0;
  return {
    async read(path, { conditional = false } = {}) {
      const previous = conditional ? cache.get(path) : undefined;
      const response = await request(base + path, {
        headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
          ...(previous?.etag ? { "If-None-Match": previous.etag } : {}) },
        signal: AbortSignal.timeout(10_000),
      });
      last = response.headers;
      if (response.status === 304) {
        unchanged++;
        if (!previous) throw new Error("Conditional workflow response has no cached data.");
        return previous.data;
      }
      counted++;
      if (!response.ok) throw new Error(`Cannot read workflow ${path}: HTTP ${response.status}.`);
      const data = await response.json();
      if (conditional) cache.set(path, { etag: last?.get("etag"), data });
      return data;
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
