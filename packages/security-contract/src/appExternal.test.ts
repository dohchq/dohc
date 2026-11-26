import { describe, expect, it } from "vitest";
import {
  AppExternalInputError,
  parseAppExternalDeclaration,
  parseAppExternalOperation,
  renderAppExternalRequest,
} from "./appExternal";

const posthog = {
  recentEvents: {
    method: "POST",
    url: "https://us.posthog.com/api/projects/{{project}}/query/",
    query: { format: "json" },
    headers: { Accept: "application/json" },
    body: {
      query: {
        kind: "HogQLQuery",
        query: "select event, count() from events where timestamp > now() - interval {days} day",
        values: { days: "{{days}}" },
      },
      refresh: "{{refresh}}",
    },
    params: {
      project: { type: "integer", min: 1, max: 99_999_999 },
      days: { type: "integer", min: 1, max: 90 },
      refresh: { type: "enum", values: ["blocking", "force_cache"] },
    },
    secret: { name: "POSTHOG_KEY", header: "Authorization", prefix: "Bearer " },
  },
};

const declare = (patch: Record<string, unknown>) =>
  parseAppExternalDeclaration({ op: { ...posthog.recentEvents, ...patch } });

describe("declared external operations", () => {
  it("normalizes a declaration into the form an approval binds", () => {
    const [op] = parseAppExternalDeclaration(posthog);
    expect(op).toMatchObject({
      name: "recentEvents",
      method: "POST",
      host: "us.posthog.com",
      path: "/api/projects/{{project}}/query/",
      access: "owner",
      response: { maxBytes: 192 * 1024 },
      secret: { name: "POSTHOG_KEY", header: "Authorization", prefix: "Bearer " },
    });
    expect(parseAppExternalOperation(op)).toEqual(op);
  });

  it("renders only the declared request, with typed values in their slots", () => {
    const [op] = parseAppExternalDeclaration(posthog);
    const request = renderAppExternalRequest(op!, { project: 42, days: 7, refresh: "blocking" });
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://us.posthog.com/api/projects/42/query/?format=json");
    expect(request.headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(request.body!)).toEqual({
      query: {
        kind: "HogQLQuery",
        query: "select event, count() from events where timestamp > now() - interval {days} day",
        values: { days: 7 },
      },
      refresh: "blocking",
    });
  });

  it.each([
    [{ project: 42, days: 7 }, 'Input "refresh" is missing.'],
    [
      { project: 42, days: 91, refresh: "blocking" },
      'Input "days" must be a whole number from 1 to 90.',
    ],
    [{ project: "42", days: 7, refresh: "blocking" }, 'Input "project" must be a whole number'],
    [{ project: 42, days: 7, refresh: "drop" }, 'Input "refresh" must be one of'],
    [{ project: 42, days: 7, refresh: "blocking", host: "evil.example" }, 'has no input "host"'],
  ])("refuses input outside the declaration: %j", (input, message) => {
    const [op] = parseAppExternalDeclaration(posthog);
    expect(() => renderAppExternalRequest(op!, input)).toThrow(AppExternalInputError);
    expect(() => renderAppExternalRequest(op!, input)).toThrow(message);
  });

  it("keeps a text input from leaving its path segment", () => {
    const [op] = declare({
      method: "GET",
      url: "https://api.linear.app/teams/{{team}}",
      body: undefined,
      query: undefined,
      params: { team: { type: "string", maxLength: 64 } },
    });
    expect(renderAppExternalRequest(op!, { team: "ENG-1" }).url).toBe(
      "https://api.linear.app/teams/ENG-1",
    );
    for (const team of ["..", ".", "a/b", "a%2fb", "a?b", "a b"])
      expect(() => renderAppExternalRequest(op!, { team })).toThrow("can't go in the address");
  });

  it.each([
    [{ method: "DELETE" }, "method must be GET or POST"],
    [{ method: "GET" }, "sends a body, so its method must be POST"],
    [{ url: "http://us.posthog.com/x" }, "url must be https://host/path"],
    [{ url: "https://localhost/x" }, "host must be a lowercase public hostname"],
    [{ url: "https://127.0.0.1/x" }, "host must be a lowercase public hostname"],
    [{ url: "https://us.posthog.com/a?x=1" }, "no query or fragment"],
    [{ url: "https://us.posthog.com/a/../b" }, 'path segment ".." is not allowed'],
    [{ url: "https://us.posthog.com/a/%2e%2e/b" }, "is not allowed"],
    [{ url: "https://us.posthog.com/a//b" }, 'path segment "" is not allowed'],
    [{ url: "https://US.posthog.com/{{project}}/" }, "host must be a lowercase"],
    [{ headers: { Authorization: "x" } }, 'header "Authorization" can\'t be set here'],
    [{ headers: { Host: "evil.example" } }, "can't be set"],
    [{ headers: { "X-Note": "{{days}}" } }, "must be fixed printable text"],
    [{ secret: { name: "POSTHOG_KEY", header: "Cookie" } }, "can't be set"],
    [{ secret: { name: "POSTHOG_KEY", header: "Accept" } }, "clashes with another header"],
    [{ secret: { name: "posthog", header: "Authorization" } }, "secret name must look like"],
    [
      { secret: { name: "POSTHOG_KEY", header: "Authorization", prefix: "Bearer\r\n" } },
      "secret prefix",
    ],
    [{ body: { q: "select {{days}}" } }, "is not exactly one {{input}}"],
    [{ body: { q: "{{missing}}" } }, "uses {{missing}} but doesn't declare it"],
    [
      { params: { ...posthog.recentEvents.params, extra: { type: "boolean" } } },
      'declares input "extra" but never uses it',
    ],
    [{ access: "anyone" }, 'access must be "owner" or "viewers"'],
    [{ maxResponseBytes: 2 * 1024 * 1024 }, "response limit must be from"],
    [{ timeoutMs: 60_000 }, 'unknown field "timeoutMs"'],
  ])("refuses a declaration that isn't fixed: %j", (patch, message) => {
    expect(() => declare(patch)).toThrow(message);
  });
});
