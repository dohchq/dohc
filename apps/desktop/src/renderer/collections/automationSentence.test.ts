import { describe, expect, it } from "vitest";
import {
  automationSentence,
  httpAllowText,
  sentenceText,
  type Automation,
} from "./automationSentence";

const fetchStats: Automation = {
  id: "pull",
  name: "Pull stats",
  enabled: true,
  when: { kind: "schedule", every: "hour", at: ":00", timezone: "UTC" },
  if: null,
  do: [
    {
      kind: "http",
      url: { kind: "literal", url: "https://us.posthog.com/api/projects/1/query/" },
      method: "GET",
      headers: [],
      secretHeaders: [{ name: "Authorization", secret: "POSTHOG_KEY", prefix: "Bearer " }],
      body: null,
      as: "stats",
    },
    {
      kind: "add-record",
      values: [
        { field: "Pageviews", value: { kind: "formula", expression: "stats.results[0][0]" } },
        { field: "Source", value: { kind: "literal", value: "PostHog" } },
      ],
      collection: null,
      as: null,
      operation: null,
    },
    { kind: "run-file", file: "rows.js", as: null },
  ],
};

describe("http step copy", () => {
  it("says which website a fetch calls, which secret it attaches, and which fields it writes", () => {
    expect(httpAllowText(fetchStats, 0)).toBe(
      "This step fetches data from us.posthog.com with secret POSTHOG_KEY in its Authorization header, and saves the answer as stats. Later steps write Pageviews from it and run rows.js with it. Allow it before dohc sends requests there.",
    );
    expect(sentenceText(automationSentence(fetchStats))).toContain(
      "fetch data from us.posthog.com and save it as stats",
    );
  });

  it("keeps the webhook wording and undo warning for a POST that saves nothing", () => {
    const webhook: Automation = {
      ...fetchStats,
      do: [
        {
          kind: "http",
          url: { kind: "secret", secret: "SLACK_HOOK" },
          method: "POST",
          headers: [],
          secretHeaders: [],
          body: {
            kind: "json",
            fields: [{ key: "title", value: { kind: "literal", value: "Hi" } }],
          },
          as: null,
        },
      ],
    };
    expect(httpAllowText(webhook, 0)).toBe(
      "This step sends a webhook to secret SLACK_HOOK with a JSON body with title. Sent requests cannot be undone. Allow it before dohc sends requests there.",
    );
    expect(httpAllowText(webhook, 1)).toBeNull();
  });

  it("names later steps that send the answer elsewhere or branch on it", () => {
    const fetch = fetchStats.do[0]!;
    const spread: Automation = {
      ...fetchStats,
      do: [
        fetch,
        { kind: "post", text: "Revenue {stats.revenue}", group: "Everyone" },
        {
          kind: "invoke",
          collection: null,
          operation: "import",
          input: [{ key: "rows", value: { kind: "formula", expression: "stats.rows" } }],
        },
        {
          kind: "if",
          if: "stats.enabled",
          do: [
            {
              kind: "set",
              values: [{ field: "Status", value: { kind: "literal", value: "On" } }],
              records: null,
              operation: null,
            },
          ],
          otherwise: [],
        },
        { kind: "notify", text: "Done", to: [{ kind: "literal", value: "bob@dohc.test" }] },
      ],
    };
    expect(httpAllowText(spread, 0)).toBe(
      "This step fetches data from us.posthog.com with secret POSTHOG_KEY in its Authorization header, and saves the answer as stats. Later steps use it to post in Everyone, run import, and decide whether to set Status to On. Allow it before dohc sends requests there.",
    );
    const named: Automation = {
      ...fetchStats,
      do: [
        { ...fetch, as: "group" } as typeof fetch,
        { kind: "post", text: "Done", group: "Everyone" },
      ],
    };
    expect(httpAllowText(named, 0)).toContain("No later step uses it yet.");
  });
});
