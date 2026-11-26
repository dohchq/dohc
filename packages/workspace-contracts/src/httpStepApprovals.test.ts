import { describe, expect, it } from "vitest";
import {
  hasHttpStep,
  hasPersonalStep,
  httpStepTargetLabel,
  parseAutomationsFile,
  writeAutomationsFile,
  type AutomationHttpStep,
} from "./automations";
import { createHash } from "node:crypto";
import {
  computeHttpStepApprovalDigest,
  sanitizeHttpFailureReason,
  workspaceSecretApprovalBinding,
} from "./httpStepApprovals";

describe("http automation steps", () => {
  it("parses and round-trips literal URL, secret URL, headers, secret headers, JSON body, and text body", () => {
    const yaml = `version: 1
automations:
  - id: notify-hook
    name: Notify webhook
    when: record-added
    do:
      - http: https://hooks.example.com/events
        method: POST
        headers:
          X-Source: dohc
          X-Title: '=record.Title'
        secret-headers:
          Authorization:
            secret: HOOK_TOKEN
            prefix: 'Bearer '
        body:
          title: '=record.Title'
          count: 3
      - http:
          secret: SLACK_WEBHOOK_URL
        body: 'Added {record.Title}'
`;
    const parsed = parseAutomationsFile(yaml);
    expect(parsed.status).toBe("read");
    if (parsed.status !== "read") return;
    expect(parsed.entries).toHaveLength(1);
    const entry = parsed.entries[0]!;
    expect(entry.status).toBe("valid");
    if (entry.status !== "valid") return;

    expect(hasPersonalStep(entry.automation)).toBe(true);
    expect(hasHttpStep(entry.automation)).toBe(true);
    expect(entry.automation.do).toHaveLength(2);
    const first = entry.automation.do[0] as AutomationHttpStep;
    const second = entry.automation.do[1] as AutomationHttpStep;
    expect(first.kind).toBe("http");
    expect(first.url).toEqual({ kind: "literal", url: "https://hooks.example.com/events" });
    expect(httpStepTargetLabel(first)).toBe("hooks.example.com");
    expect(second.url).toEqual({ kind: "secret", secret: "SLACK_WEBHOOK_URL" });
    expect(httpStepTargetLabel(second)).toBe("secret SLACK_WEBHOOK_URL");

    const written = writeAutomationsFile(parsed.entries);
    expect(written.status).toBe("ok");
    if (written.status !== "ok") return;
    const reparsed = parseAutomationsFile(written.text);
    expect(reparsed).toEqual(parsed);
  });

  it("detects personal and http steps nested inside if branches", () => {
    const yaml = `version: 1
automations:
  - id: nested-hook
    name: Nested webhook
    when: record-added
    do:
      - if: record.Status == "Done"
        do:
          - http: https://hooks.example.com/done
`;
    const parsed = parseAutomationsFile(yaml);
    expect(parsed.status).toBe("read");
    if (parsed.status !== "read" || parsed.entries[0]?.status !== "valid") return;
    expect(hasPersonalStep(parsed.entries[0].automation)).toBe(true);
    expect(hasHttpStep(parsed.entries[0].automation)).toBe(true);
  });

  it("rejects unsafe URLs, formula URLs, braces in URLs, non-POST methods, forbidden or colliding headers, and >3 http steps", () => {
    const cases: Array<[string, string]> = [
      [
        "non-https URL",
        `version: 1
automations:
  - id: a
    name: A
    when: record-added
    do:
      - http: http://hooks.example.com/events
`,
      ],
      [
        "braces in literal URL",
        `version: 1
automations:
  - id: a
    name: A
    when: record-added
    do:
      - http: https://hooks.example.com/{record.id}
`,
      ],
      [
        "formula URL",
        `version: 1
automations:
  - id: a
    name: A
    when: record-added
    do:
      - http: '=record.Url'
`,
      ],
      [
        "GET method",
        `version: 1
automations:
  - id: a
    name: A
    when: record-added
    do:
      - http: https://hooks.example.com/events
        method: GET
`,
      ],
      [
        "forbidden Host header",
        `version: 1
automations:
  - id: a
    name: A
    when: record-added
    do:
      - http: https://hooks.example.com/events
        headers:
          Host: evil.example.com
`,
      ],
      [
        "forbidden X-Dohc header",
        `version: 1
automations:
  - id: a
    name: A
    when: record-added
    do:
      - http: https://hooks.example.com/events
        headers:
          X-Dohc-Chain-Depth: '0'
`,
      ],
      [
        "forbidden User-Agent header",
        `version: 1
automations:
  - id: a
    name: A
    when: record-added
    do:
      - http: https://hooks.example.com/events
        headers:
          User-Agent: custom-agent/1
`,
      ],
      [
        "forbidden __proto__ header",
        `version: 1
automations:
  - id: a
    name: A
    when: record-added
    do:
      - http: https://hooks.example.com/events
        headers:
          __proto__: polluted
`,
      ],
      [
        "case-insensitive collision between headers and secret-headers",
        `version: 1
automations:
  - id: a
    name: A
    when: record-added
    do:
      - http: https://hooks.example.com/events
        headers:
          authorization: public
        secret-headers:
          Authorization:
            secret: API_KEY
`,
      ],
      [
        "more than 3 http steps",
        `version: 1
automations:
  - id: a
    name: A
    when: record-added
    do:
      - http: https://hooks.example.com/1
      - http: https://hooks.example.com/2
      - http: https://hooks.example.com/3
      - http: https://hooks.example.com/4
`,
      ],
    ];

    for (const [label, yaml] of cases) {
      const parsed = parseAutomationsFile(yaml);
      expect(parsed.status, label).toBe("read");
      if (parsed.status !== "read") continue;
      expect(parsed.entries[0]?.status, label).toBe("invalid");
    }
  });

  it("binds approval digests to step content, collectionId, collectionPath, definitionDigest, and locale-independent run-file code hashes", () => {
    const step: AutomationHttpStep = {
      kind: "http",
      url: { kind: "literal", url: "https://hooks.example.com/notify" },
      method: "POST",
      headers: [{ name: "X-Event", value: { kind: "literal", value: "added" } }],
      secretHeaders: [{ name: "Authorization", secret: "HOOK_TOKEN", prefix: "Bearer " }],
      body: { kind: "text", template: "Added {record.Title}" },
    };

    const base = computeHttpStepApprovalDigest({
      collectionId: "col-obj-1",
      collectionPath: "Tasks",
      automationId: "notify",
      stepOrdinal: 0,
      step,
      definitionDigest: "a".repeat(64),
      secretBindings: new Map([["HOOK_TOKEN", "binding"]]),
      codeFileHashes: [
        { file: "ä.js", sha256: "3".repeat(64) },
        { file: "z.js", sha256: "2".repeat(64) },
        { file: "a.js", sha256: "1".repeat(64) },
      ],
    });
    const reordered = computeHttpStepApprovalDigest({
      collectionId: "col-obj-1",
      collectionPath: "Tasks",
      automationId: "notify",
      stepOrdinal: 0,
      step,
      definitionDigest: "a".repeat(64),
      secretBindings: new Map([["HOOK_TOKEN", "binding"]]),
      codeFileHashes: [
        { file: "a.js", sha256: "1".repeat(64) },
        { file: "z.js", sha256: "2".repeat(64) },
        { file: "ä.js", sha256: "3".repeat(64) },
      ],
    });
    expect(base).toBe(reordered);

    const replacedCollection = computeHttpStepApprovalDigest({
      collectionId: "col-obj-2",
      collectionPath: "Tasks",
      automationId: "notify",
      stepOrdinal: 0,
      step,
      definitionDigest: "a".repeat(64),
      secretBindings: new Map([["HOOK_TOKEN", "binding"]]),
      codeFileHashes: [
        { file: "a.js", sha256: "1".repeat(64) },
        { file: "z.js", sha256: "2".repeat(64) },
        { file: "ä.js", sha256: "3".repeat(64) },
      ],
    });
    expect(replacedCollection).not.toBe(base);

    const changedCode = computeHttpStepApprovalDigest({
      collectionId: "col-obj-1",
      collectionPath: "Tasks",
      automationId: "notify",
      stepOrdinal: 0,
      step,
      definitionDigest: "a".repeat(64),
      secretBindings: new Map([["HOOK_TOKEN", "binding"]]),
      codeFileHashes: [
        { file: "a.js", sha256: "9".repeat(64) },
        { file: "z.js", sha256: "2".repeat(64) },
        { file: "ä.js", sha256: "3".repeat(64) },
      ],
    });
    expect(changedCode).not.toBe(base);

    const movedCollection = computeHttpStepApprovalDigest({
      collectionId: "col-obj-1",
      collectionPath: "Shared/Tasks",
      automationId: "notify",
      stepOrdinal: 0,
      step,
      definitionDigest: "a".repeat(64),
      secretBindings: new Map([["HOOK_TOKEN", "binding"]]),
      codeFileHashes: [
        { file: "a.js", sha256: "1".repeat(64) },
        { file: "z.js", sha256: "2".repeat(64) },
        { file: "ä.js", sha256: "3".repeat(64) },
      ],
    });
    expect(movedCollection).not.toBe(base);
  });

  it("keeps the first digest format for steps that name no secret", () => {
    const step: AutomationHttpStep = {
      kind: "http",
      url: { kind: "literal", url: "https://hooks.example.com/notify" },
      method: "POST",
      headers: [{ name: "X-Event", value: { kind: "literal", value: "added" } }],
      secretHeaders: [],
      body: null,
    };
    const digest = computeHttpStepApprovalDigest({
      collectionId: "col-obj-1",
      collectionPath: "Tasks",
      automationId: "notify",
      stepOrdinal: 0,
      step,
      definitionDigest: "a".repeat(64),
      codeFileHashes: [],
      secretBindings: null,
    });
    expect(digest).toBe(
      createHash("sha256")
        .update(
          JSON.stringify([
            "dohc-http-step-approval-v1",
            "col-obj-1",
            "Tasks",
            "notify",
            0,
            ["literal", "https://hooks.example.com/notify"],
            "POST",
            ["x-event"],
            [],
            "a".repeat(64),
            [],
          ]),
        )
        .digest("hex"),
    );
  });

  it("ties a secret step's approval to each secret's identity", () => {
    const step: AutomationHttpStep = {
      kind: "http",
      url: { kind: "secret", secret: "HOOK_URL" },
      method: "POST",
      headers: [],
      secretHeaders: [{ name: "Authorization", secret: "HOOK_TOKEN", prefix: "Bearer " }],
      body: null,
    };
    const digestWith = (
      urlSecret: Parameters<typeof workspaceSecretApprovalBinding>[0] | null,
      token: Parameters<typeof workspaceSecretApprovalBinding>[0],
    ) => {
      const bindings = new Map([["HOOK_TOKEN", workspaceSecretApprovalBinding(token)]]);
      if (urlSecret) bindings.set("HOOK_URL", workspaceSecretApprovalBinding(urlSecret));
      return computeHttpStepApprovalDigest({
        collectionId: "col-obj-1",
        collectionPath: "Tasks",
        automationId: "notify",
        stepOrdinal: 0,
        step,
        definitionDigest: "a".repeat(64),
        codeFileHashes: [],
        secretBindings: bindings,
      });
    };
    const url = { usage: "http-url" as const, allowedHosts: [], createdAtMs: 10, generation: 1 };
    const token = {
      usage: "http-header" as const,
      allowedHosts: ["api.example.com"],
      createdAtMs: 20,
      generation: 1,
    };
    const approved = digestWith(url, token);
    expect(approved).toMatch(/^[0-9a-f]{64}$/u);
    expect(digestWith(url, { ...token, generation: 7 })).toBe(approved);
    expect(digestWith({ ...url, generation: 2 }, token)).not.toBe(approved);
    expect(digestWith({ ...url, createdAtMs: 11 }, token)).not.toBe(approved);
    expect(digestWith(url, { ...token, createdAtMs: 21 })).not.toBe(approved);
    expect(digestWith(url, { ...token, allowedHosts: ["evil.example.com"] })).not.toBe(approved);
    expect(digestWith(null, token)).not.toBe(approved);
    expect(
      computeHttpStepApprovalDigest({
        collectionId: "col-obj-1",
        collectionPath: "Tasks",
        automationId: "notify",
        stepOrdinal: 0,
        step,
        definitionDigest: "a".repeat(64),
        codeFileHashes: [],
        secretBindings: null,
      }),
    ).toBeNull();
  });

  it("scrubs secrets from failure reasons", () => {
    const scrubbed = sanitizeHttpFailureReason(
      "Failed calling https://hooks.slack.com/services/T1/B2/SECRET with token sk_live_123456",
      ["https://hooks.slack.com/services/T1/B2/SECRET", "sk_live_123456"],
    );
    expect(scrubbed).not.toContain("SECRET");
    expect(scrubbed).not.toContain("sk_live_123456");
    expect(scrubbed).toContain("[redacted]");
  });
});
