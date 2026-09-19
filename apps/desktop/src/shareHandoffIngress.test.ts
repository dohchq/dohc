import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyShareHandoffArguments,
  createShareHandoffIntentSlot,
  focusShareHandoffWindow,
  focusShareHandoffWindowWhenReady,
  parseShareHandoffUrl,
  receiveShareHandoffArguments,
  registerShareHandoffProtocol,
} from "./shareHandoffIngress";

const CODE_A = "A".repeat(43);
const CODE_B = `${"b".repeat(42)}_`;
const RELAY_A = "https://relay-a.example";
const RELAY_B = "https://relay-b.example";
const COORDINATE_URL = `dohc://open/${CODE_A}?relay=${encodeURIComponent(RELAY_A)}`;
const VALID_URL = COORDINATE_URL;
const CASE_VARIANT_URLS = [
  ["upper-case scheme", `DOHC://open/${CODE_A}?relay=${encodeURIComponent(RELAY_A)}`],
  ["upper-case host", `dohc://OPEN/${CODE_A}?relay=${encodeURIComponent(RELAY_A)}`],
  ["mixed-case scheme and host", `DoHc://OpEn/${CODE_A}?relay=${encodeURIComponent(RELAY_A)}`],
] as const;

const INVALID_URLS = [
  ["coordinate-less form", `dohc://open/${CODE_A}`],
  ["extra query", `${VALID_URL}&source=browser`],
  ["duplicate relay", `${VALID_URL}&relay=${encodeURIComponent(RELAY_B)}`],
  ["fragment", `${VALID_URL}#handoff`],
  ["credentials", `dohc://user@open/${CODE_A}?relay=${encodeURIComponent(RELAY_A)}`],
  ["port", `dohc://open:443/${CODE_A}?relay=${encodeURIComponent(RELAY_A)}`],
  ["extra path segment", `dohc://open/${CODE_A}/extra?relay=${encodeURIComponent(RELAY_A)}`],
  ["empty path segment", `dohc://open//${CODE_A}?relay=${encodeURIComponent(RELAY_A)}`],
  ["empty code", `dohc://open/?relay=${encodeURIComponent(RELAY_A)}`],
  ["trailing slash", `dohc://open/${CODE_A}/?relay=${encodeURIComponent(RELAY_A)}`],
  ["percent-encoded code", `dohc://open/${"A".repeat(42)}%41?relay=${encodeURIComponent(RELAY_A)}`],
  ["unencoded relay", `dohc://open/${CODE_A}?relay=${RELAY_A}`],
  ["relay credentials", `dohc://open/${CODE_A}?relay=${encodeURIComponent("https://user:pass@relay-a.example")}`],
  ["relay query", `dohc://open/${CODE_A}?relay=${encodeURIComponent("https://relay-a.example?token=secret")}`],
  ["relay fragment", `dohc://open/${CODE_A}?relay=${encodeURIComponent("https://relay-a.example#secret")}`],
  ["noncanonical relay host", `dohc://open/${CODE_A}?relay=${encodeURIComponent("https://Relay-A.Example/")}`],
  ["invalid relay encoding", `dohc://open/${CODE_A}?relay=%ZZ`],
  ["leading whitespace", ` ${VALID_URL}`],
  ["trailing whitespace", `${VALID_URL} `],
  ["trailing line feed", `${VALID_URL}\n`],
  ["trailing carriage return", `${VALID_URL}\r`],
  ["wrong scheme", `https://open/${CODE_A}?relay=${encodeURIComponent(RELAY_A)}`],
  ["wrong host", `dohc://handoff/${CODE_A}?relay=${encodeURIComponent(RELAY_A)}`],
  ["single-slash lookalike", `dohc:/open/${CODE_A}?relay=${encodeURIComponent(RELAY_A)}`],
  ["prefixed-scheme lookalike", `xdohc://open/${CODE_A}`],
  ["host-suffix lookalike", `dohc://open.example/${CODE_A}?relay=${encodeURIComponent(RELAY_A)}`],
  ["short code", `dohc://open/${"A".repeat(42)}?relay=${encodeURIComponent(RELAY_A)}`],
  ["long code", `dohc://open/${"A".repeat(44)}?relay=${encodeURIComponent(RELAY_A)}`],
  ["forbidden code character", `dohc://open/${"A".repeat(42)}.?relay=${encodeURIComponent(RELAY_A)}`],
  ["Unicode case-folding code character", `dohc://open/${"A".repeat(42)}K?relay=${encodeURIComponent(RELAY_A)}`],
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("share handoff URL parser", () => {
  it("parses the code and canonical issuer relay as one intent", () => {
    expect(parseShareHandoffUrl(COORDINATE_URL)).toEqual({
      code: CODE_A,
      relayUrl: RELAY_A,
    });
  });

  it("accepts the one exact raw grammar", () => {
    expect(parseShareHandoffUrl(VALID_URL)).toEqual({
      code: CODE_A,
      relayUrl: RELAY_A,
    });
  });

  it.each(CASE_VARIANT_URLS)("accepts %s", (_label, rawArgument) => {
    expect(parseShareHandoffUrl(rawArgument)).toEqual({
      code: CODE_A,
      relayUrl: RELAY_A,
    });
  });

  it.each(INVALID_URLS)("rejects %s", (_label, rawArgument) => {
    expect(parseShareHandoffUrl(rawArgument)).toBeNull();
  });
});

describe("share handoff argument classifier", () => {
  it.each([
    ["plain launch", ["dohc.exe"], "plain"],
    ["exact accepted handoff", ["dohc.exe", VALID_URL], "accepted"],
    [
      "accepted upper-case scheme",
      ["dohc.exe", CASE_VARIANT_URLS[0][1]],
      "accepted",
    ],
    [
      "accepted upper-case host",
      ["dohc.exe", CASE_VARIANT_URLS[1][1]],
      "accepted",
    ],
    [
      "accepted mixed-case scheme and host",
      ["dohc.exe", CASE_VARIANT_URLS[2][1]],
      "accepted",
    ],
    [
      "rejected lower-case lookalike",
      ["dohc.exe", `${VALID_URL}?source=browser`],
      "rejected",
    ],
    [
      "workspace path plus rejected lookalike",
      ["dohc.exe", "C:\\workspaces\\trip", `${VALID_URL}#handoff`],
      "rejected",
    ],
  ] as const)("classifies %s", (_label, argv, expected) => {
    expect(classifyShareHandoffArguments(argv)).toBe(expected);
  });
});

describe("share handoff memory slot", () => {
  it("collapses only exact intent-pair duplicates", () => {
    const slot = createShareHandoffIntentSlot();
    const intent = parseShareHandoffUrl(VALID_URL);
    expect(intent).not.toBeNull();
    if (!intent) return;

    expect(slot.offer(intent)).toBe("stored");
    expect(slot.offer({ ...intent })).toBe("duplicate");
    expect(slot.pending()).toEqual({ code: CODE_A, relayUrl: RELAY_A });
    expect(slot.pending()).not.toBe(VALID_URL);
    expect(JSON.stringify(slot)).not.toContain("dohc://");
  });

  it("replaces either changed member and settles only the observed pair", () => {
    const slot = createShareHandoffIntentSlot();
    const first = parseShareHandoffUrl(VALID_URL);
    const changedRelay = parseShareHandoffUrl(
      `dohc://open/${CODE_A}?relay=${encodeURIComponent(RELAY_B)}`,
    );
    const changedCode = parseShareHandoffUrl(
      `dohc://open/${CODE_B}?relay=${encodeURIComponent(RELAY_B)}`,
    );
    expect(first).not.toBeNull();
    expect(changedRelay).not.toBeNull();
    expect(changedCode).not.toBeNull();
    if (!first || !changedRelay || !changedCode) return;

    expect(slot.snapshot()).toEqual({ intent: null, generation: 0 });
    expect(slot.offer(first)).toBe("stored");
    expect(slot.snapshot()).toEqual({ intent: first, generation: 1 });
    expect(slot.offer(first)).toBe("duplicate");
    expect(slot.snapshot()).toEqual({ intent: first, generation: 1 });
    expect(slot.offer(changedRelay)).toBe("replaced");
    expect(slot.snapshot()).toEqual({ intent: changedRelay, generation: 2 });
    expect(slot.settle(first)).toBe(false);
    expect(slot.snapshot()).toEqual({ intent: changedRelay, generation: 2 });
    expect(slot.offer(changedCode)).toBe("replaced");
    expect(slot.snapshot()).toEqual({ intent: changedCode, generation: 3 });
    expect(slot.settle(changedRelay)).toBe(false);
    expect(slot.pending()).toEqual(changedCode);
    expect(slot.settle({ ...changedCode })).toBe(true);
    expect(slot.snapshot()).toEqual({ intent: null, generation: 4 });
    expect(slot.pending()).toBeNull();
  });
});

describe("share handoff delivery", () => {
  it("keeps a pre-ready macOS open-url delivery pending without a window action", () => {
    const slot = createShareHandoffIntentSlot();

    expect(receiveShareHandoffArguments([VALID_URL], slot)).toBe(true);
    expect(slot.pending()).toEqual({ code: CODE_A, relayUrl: RELAY_A });
  });

  it("delivers a casing variant as only the canonical intent pair", () => {
    const slot = createShareHandoffIntentSlot();
    const rawArgument = CASE_VARIANT_URLS[2][1];

    expect(receiveShareHandoffArguments([rawArgument], slot)).toBe(true);
    expect(slot.pending()).toEqual({ code: CODE_A, relayUrl: RELAY_A });
    expect(slot.pending()).not.toBe(rawArgument);
  });

  it("restores, shows, and focuses once for a valid warm delivery", () => {
    const slot = createShareHandoffIntentSlot();
    const calls: string[] = [];
    const window = {
      isMinimized: () => true,
      restore: () => calls.push("restore"),
      show: () => calls.push("show"),
      focus: () => calls.push("focus"),
    };

    const accepted = receiveShareHandoffArguments([VALID_URL], slot);
    if (accepted) focusShareHandoffWindow(window);

    expect(accepted).toBe(true);
    expect(calls).toEqual(["restore", "show", "focus"]);
    expect(slot.pending()).toEqual({ code: CODE_A, relayUrl: RELAY_A });
  });

  it("waits for ready-to-show before focusing a newly created window", () => {
    const calls: string[] = [];
    let readyToShow: (() => void) | undefined;
    const window = {
      isMinimized: () => true,
      restore: () => calls.push("restore"),
      show: () => calls.push("show"),
      focus: () => calls.push("focus"),
      once: (event: "ready-to-show", listener: () => void) => {
        expect(event).toBe("ready-to-show");
        readyToShow = listener;
      },
    };

    focusShareHandoffWindowWhenReady(window);

    expect(calls).toEqual([]);
    expect(readyToShow).toBeTypeOf("function");
    readyToShow?.();
    expect(calls).toEqual(["restore", "show", "focus"]);
  });

  it("ignores an invalid lookalike without changing focus or pending intent", () => {
    const slot = createShareHandoffIntentSlot();
    const calls: string[] = [];
    const window = {
      isMinimized: () => true,
      restore: () => calls.push("restore"),
      show: () => calls.push("show"),
      focus: () => calls.push("focus"),
    };
    expect(receiveShareHandoffArguments([VALID_URL], slot)).toBe(true);

    const accepted = receiveShareHandoffArguments(
      [`${VALID_URL}?lookalike=1`],
      slot,
    );
    if (accepted) focusShareHandoffWindow(window);

    expect(accepted).toBe(false);
    expect(calls).toEqual([]);
    expect(slot.pending()).toEqual({ code: CODE_A, relayUrl: RELAY_A });
  });

  it("does not write accepted or rejected protocol arguments to console recorders", () => {
    const recorders = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
    ];
    const slot = createShareHandoffIntentSlot();

    receiveShareHandoffArguments(
      [VALID_URL, `${VALID_URL}?must-not-be-recorded=1`],
      slot,
    );

    for (const recorder of recorders) expect(recorder).not.toHaveBeenCalled();
  });
});

describe("share handoff runtime registration", () => {
  it.each([true, false])("leaves the OS handler untouched for isolated QA (defaultApp=%s)", (defaultApp) => {
    const setAsDefaultProtocolClient = vi.fn(() => true);
    expect(registerShareHandoffProtocol({ setAsDefaultProtocolClient }, {
      defaultApp,
      execPath: "dohc.exe",
      argv: ["dohc.exe", "--dohc-isolated-test", `--user-data-dir=${resolve("isolated-profile")}`],
    })).toBe(false);
    expect(setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it.each([[], ["--user-data-dir=relative"], ["--user-data-dir="],
    [`--user-data-dir=${resolve("one")}`, `--user-data-dir=${resolve("two")}`],
  ])("rejects an isolated launch without one absolute profile: %j", (...profileArgs) => {
    const setAsDefaultProtocolClient = vi.fn(() => true);
    expect(() => registerShareHandoffProtocol({ setAsDefaultProtocolClient }, {
      execPath: "dohc.exe",
      argv: ["dohc.exe", "--dohc-isolated-test", ...profileArgs],
    })).toThrow("one absolute --user-data-dir");
    expect(setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it("keeps protocol registration for a normal launch with a custom profile", () => {
    const setAsDefaultProtocolClient = vi.fn(() => true);
    expect(registerShareHandoffProtocol({ setAsDefaultProtocolClient }, {
      execPath: "dohc.exe",
      argv: ["dohc.exe", `--user-data-dir=${resolve("custom-profile")}`],
    })).toBe(true);
    expect(setAsDefaultProtocolClient).toHaveBeenCalledWith("dohc");
  });

  it("registers the development entry with Electron's exact argument shape", () => {
    const calls: unknown[][] = [];
    const registrar = {
      setAsDefaultProtocolClient: (...args: unknown[]) => {
        calls.push(args);
        return true;
      },
    };

    expect(
      registerShareHandoffProtocol(registrar, {
        defaultApp: true,
        execPath: "C:\\runtime\\electron.exe",
        argv: ["electron", "relative/app-entry.js"],
      }),
    ).toBe(true);
    expect(calls).toEqual([
      [
        "dohc",
        "C:\\runtime\\electron.exe",
        [resolve("relative/app-entry.js")],
      ],
    ]);
  });

  it("does not register a development handler without an app entry argument", () => {
    const setAsDefaultProtocolClient = vi.fn(() => true);

    expect(
      registerShareHandoffProtocol(
        { setAsDefaultProtocolClient },
        {
          defaultApp: true,
          execPath: "C:\\runtime\\electron.exe",
          argv: ["electron"],
        },
      ),
    ).toBe(false);
    expect(setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it("registers the packaged app with the scheme alone", () => {
    const calls: unknown[][] = [];
    const registrar = {
      setAsDefaultProtocolClient: (...args: unknown[]) => {
        calls.push(args);
        return true;
      },
    };

    expect(
      registerShareHandoffProtocol(registrar, {
        defaultApp: false,
        execPath: "C:\\Program Files\\dohc\\dohc.exe",
        argv: ["dohc.exe"],
      }),
    ).toBe(true);
    expect(calls).toEqual([["dohc"]]);
  });
});
