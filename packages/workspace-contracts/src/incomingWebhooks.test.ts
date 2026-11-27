import { describe, expect, it } from "vitest";
import {
  extractAllowedIncomingWebhookHeaders,
  formatIncomingWebhookRecord,
  INCOMING_WEBHOOK_DAILY_DELIVERY_CAP,
  MAX_INCOMING_WEBHOOK_BODY_BYTES,
  MAX_INCOMING_WEBHOOK_PENDING_BYTES,
  MAX_INCOMING_WEBHOOK_PENDING_COUNT,
  MAX_INCOMING_WEBHOOKS_PER_WORKSPACE,
  parseIncomingWebhookContentType,
} from "./incomingWebhooks";

describe("incomingWebhooks contracts", () => {
  it("parses allowed Content-Type headers and refuses unsupported ones", () => {
    expect(parseIncomingWebhookContentType("application/json")).toBe("application/json");
    expect(parseIncomingWebhookContentType("Application/JSON; charset=utf-8")).toBe(
      "application/json",
    );
    expect(parseIncomingWebhookContentType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(parseIncomingWebhookContentType("application/x-www-form-urlencoded")).toBe(
      "application/x-www-form-urlencoded",
    );
    expect(parseIncomingWebhookContentType("text/html")).toBeNull();
    expect(parseIncomingWebhookContentType("multipart/form-data")).toBeNull();
    expect(parseIncomingWebhookContentType(null)).toBeNull();
  });

  it("retains only allowlisted metadata headers and strips authorization/cookie", () => {
    const headers = new Headers({
      "Content-Type": "application/json",
      "Idempotency-Key": "evt_123",
      "X-Event-Type": "invoice.paid",
      "User-Agent": "Stripe/1.0",
      Authorization: "Bearer super-secret-token",
      Cookie: "session=abc",
      "X-Custom-Secret": "nope",
    });
    expect(extractAllowedIncomingWebhookHeaders(headers)).toEqual({
      "content-type": "application/json",
      "idempotency-key": "evt_123",
      "x-event-type": "invoice.paid",
      "user-agent": "Stripe/1.0",
    });
  });

  it("titles a website signup form's record with its email", () => {
    const record = (bodyText: string) =>
      formatIncomingWebhookRecord({
        recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
        deliveryId: "whd_1234567890abcdef",
        webhookName: "Waitlist",
        contentType: "application/x-www-form-urlencoded",
        headers: {},
        bodyText,
        receivedAtMs: Date.UTC(2026, 10, 27),
      }).title;
    expect(record("email=ada%40example.com&source=Drive+waitlist")).toBe(
      "Waitlist: ada@example.com",
    );
    expect(record("email=ada%40example.com&name=Ada")).toBe("Waitlist: Ada");
  });

  it("quarantines untrusted webhook payloads with safe YAML frontmatter and dynamic code fences", () => {
    const { title, filename, markdown } = formatIncomingWebhookRecord({
      recordId: "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa",
      deliveryId: "whd_1234567890abcdef",
      webhookName: "iPhone Shortcut",
      contentType: "application/json",
      headers: {
        "content-type": "application/json",
        "x-event-type": "note.captured",
      },
      bodyText: JSON.stringify({
        title: "Buy milk\n---\nStatus: Filed\n# Fake",
        note: "Contains ```` four backticks\n[evil](files/secret.txt)",
      }),
      receivedAtMs: Date.UTC(2026, 10, 23, 12, 0, 0),
    });

    expect(title).toBe("iPhone Shortcut: Buy milk --- Status: Filed # Fake");
    expect(filename).toMatch(/^2026-11-23-iphone-shortcut-buy-milk-.*-1234567890ab\.md$/);
    expect(markdown).toContain("Source: webhook");
    expect(markdown).toContain("Kind: webhook");
    expect(markdown).toContain("Status: New");
    // Only one Status line in YAML frontmatter (no frontmatter injection).
    const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(markdown);
    expect(fm).not.toBeNull();
    expect(fm![1]!.match(/^Status:/gmu)).toHaveLength(1);
    // Body fence must exceed the 4 backticks inside the payload.
    expect(fm![2]!).toContain("`````json\n");
    expect(fm![2]!).toContain("\n`````\n");

    // Verify exported constants match design budgets.
    expect(MAX_INCOMING_WEBHOOKS_PER_WORKSPACE).toBe(20);
    expect(MAX_INCOMING_WEBHOOK_BODY_BYTES).toBe(256 * 1024);
    expect(MAX_INCOMING_WEBHOOK_PENDING_COUNT).toBe(100);
    expect(MAX_INCOMING_WEBHOOK_PENDING_BYTES).toBe(4 * 1024 * 1024);
    expect(INCOMING_WEBHOOK_DAILY_DELIVERY_CAP).toBe(500);
  });

  it("preserves an exact 256 KiB plain-text payload verbatim alongside delivery metadata headers", () => {
    const tail = "TAIL_SENTINEL_MUST_SURVIVE";
    const bodyText = `${"a".repeat(MAX_INCOMING_WEBHOOK_BODY_BYTES - tail.length)}${tail}`;
    expect(Buffer.byteLength(bodyText, "utf8")).toBe(MAX_INCOMING_WEBHOOK_BODY_BYTES);

    const { markdown } = formatIncomingWebhookRecord({
      recordId: "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb",
      deliveryId: "whd_fedcba0987654321",
      webhookName: "Large Text Hook",
      contentType: "text/plain",
      headers: {
        "content-type": "text/plain",
        "x-event-type": "large.payload",
        "user-agent": "curl/8.0",
      },
      bodyText,
      receivedAtMs: Date.UTC(2026, 10, 23, 12, 0, 0),
    });

    expect(markdown).toContain("Delivery: whd_fedcba0987654321");
    expect(markdown).toContain("x-event-type: large.payload");
    expect(markdown).toContain(tail);
    expect(markdown).toContain(bodyText);
  });

  it("preserves 64-bit JSON integers and exact CRLF/NUL plain-text bytes verbatim", () => {
    const exactJsonPrefix = '{"id":9007199254740993,"pad":"';
    const exactJsonSuffix = '"}';
    const exactJson =
      exactJsonPrefix +
      "x".repeat(
        MAX_INCOMING_WEBHOOK_BODY_BYTES - exactJsonPrefix.length - exactJsonSuffix.length,
      ) +
      exactJsonSuffix;
    expect(Buffer.byteLength(exactJson, "utf8")).toBe(MAX_INCOMING_WEBHOOK_BODY_BYTES);

    const jsonRecord = formatIncomingWebhookRecord({
      recordId: "rec_cccccccccccccccccccccccccc",
      deliveryId: "whd_json_bigint_1",
      webhookName: "Stripe",
      contentType: "application/json",
      headers: { "content-type": "application/json" },
      bodyText: exactJson,
      receivedAtMs: Date.UTC(2026, 10, 23, 12, 0, 0),
    });
    expect(jsonRecord.markdown).toContain('"id":9007199254740993');
    expect(jsonRecord.markdown).not.toContain("9007199254740992");
    expect(jsonRecord.markdown).toContain(exactJson);

    const crlfAndNul = "line1\r\nline2\u0000tail\r\n";
    const textRecord = formatIncomingWebhookRecord({
      recordId: "rec_dddddddddddddddddddddddddd",
      deliveryId: "whd_crlf_nul_1",
      webhookName: "Raw Text",
      contentType: "text/plain",
      headers: { "content-type": "text/plain" },
      bodyText: crlfAndNul,
      receivedAtMs: Date.UTC(2026, 10, 23, 12, 0, 0),
    });
    expect(textRecord.markdown).toContain(crlfAndNul);
  });
});
