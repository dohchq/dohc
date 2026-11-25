// @vitest-environment jsdom
import { gunzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";

it("attaches allowlisted landing campaign tags while still stripping the URL query and other params", async () => {
  history.replaceState(
    null,
    "",
    "/?utm_source=github&utm_medium=referral&utm_campaign=launch&email=a%40b.c#hero",
  );
  const bodies: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
      bodies.push((body[0] === 0x1f ? gunzipSync(body) : Buffer.from(body)).toString());
      return new Response("{}");
    }),
  );

  const { default: posthog } = await import("posthog-js");
  await import("./analytics");
  await vi.waitFor(() => expect(posthog.__loaded).toBe(true), { timeout: 5000 });
  posthog.capture("check_utm", {}, { send_instantly: true });
  await vi.waitFor(() => expect(bodies.join()).toContain('"check_utm"'));

  const sent = bodies.join();
  expect(sent).toContain('"$current_url":"http://localhost:3000/"');
  expect(sent).toContain('"utm_source":"github"');
  expect(sent).toContain('"utm_medium":"referral"');
  expect(sent).toContain('"utm_campaign":"launch"');
  expect(sent).not.toContain("a%40b.c");
  expect(sent).not.toContain("#hero");
});
