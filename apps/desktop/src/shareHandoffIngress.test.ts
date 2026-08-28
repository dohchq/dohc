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
const VALID_URL = `dohc://open/${CODE_A}`;
const CASE_VARIANT_URLS = [
  ["upper-case scheme", `DOHC://open/${CODE_A}`],
  ["upper-case host", `dohc://OPEN/${CODE_A}`],
  ["mixed-case scheme and host", `DoHc://OpEn/${CODE_A}`],
] as const;

const INVALID_URLS = [
  ["query", `${VALID_URL}?source=browser`],
  ["fragment", `${VALID_URL}#handoff`],
  ["credentials", `dohc://user@open/${CODE_A}`],
  ["port", `dohc://open:443/${CODE_A}`],
  ["extra path segment", `${VALID_URL}/extra`],
  ["empty path segment", `dohc://open//${CODE_A}`],
  ["empty code", "dohc://open/"],
  ["trailing slash", `${VALID_URL}/`],
  ["percent encoding", `dohc://open/${"A".repeat(42)}%41`],
  ["leading whitespace", ` ${VALID_URL}`],
  ["trailing whitespace", `${VALID_URL} `],
  ["trailing line feed", `${VALID_URL}\n`],
  ["trailing carriage return", `${VALID_URL}\r`],
  ["wrong scheme", `https://open/${CODE_A}`],
  ["wrong host", `dohc://handoff/${CODE_A}`],
  ["single-slash lookalike", `dohc:/open/${CODE_A}`],
  ["prefixed-scheme lookalike", `xdohc://open/${CODE_A}`],
  ["host-suffix lookalike", `dohc://open.example/${CODE_A}`],
  ["short code", `dohc://open/${"A".repeat(42)}`],
  ["long code", `dohc://open/${"A".repeat(44)}`],
  ["forbidden code character", `dohc://open/${"A".repeat(42)}.`],
  ["Unicode case-folding code character", `dohc://open/${"A".repeat(42)}K`],
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("share handoff URL parser", () => {
  it("accepts the one exact raw grammar", () => {
    expect(parseShareHandoffUrl(VALID_URL)).toBe(CODE_A);
  });

  it.each(CASE_VARIANT_URLS)("accepts %s", (_label, rawArgument) => {
    expect(parseShareHandoffUrl(rawArgument)).toBe(CODE_A);
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
  it("collapses exact duplicates and keeps only the code", () => {
    const slot = createShareHandoffIntentSlot();
    const code = parseShareHandoffUrl(VALID_URL);
    expect(code).not.toBeNull();
    if (!code) return;

    expect(slot.offer(code)).toBe("stored");
    expect(slot.offer(code)).toBe("duplicate");
    expect(slot.pending()).toBe(CODE_A);
    expect(slot.pending()).not.toBe(VALID_URL);
    expect(JSON.stringify(slot)).not.toContain("dohc://");
  });

  it("replaces an older code and settles only the observed intent", () => {
    const slot = createShareHandoffIntentSlot();
    const first = parseShareHandoffUrl(VALID_URL);
    const second = parseShareHandoffUrl(`dohc://open/${CODE_B}`);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (!first || !second) return;

    expect(slot.snapshot()).toEqual({ code: null, generation: 0 });
    expect(slot.offer(first)).toBe("stored");
    expect(slot.snapshot()).toEqual({ code: CODE_A, generation: 1 });
    expect(slot.offer(first)).toBe("duplicate");
    expect(slot.snapshot()).toEqual({ code: CODE_A, generation: 1 });
    expect(slot.offer(second)).toBe("replaced");
    expect(slot.snapshot()).toEqual({ code: CODE_B, generation: 2 });
    expect(slot.pending()).toBe(CODE_B);
    expect(slot.settle(first)).toBe(false);
    expect(slot.snapshot()).toEqual({ code: CODE_B, generation: 2 });
    expect(slot.pending()).toBe(CODE_B);
    expect(slot.settle(second)).toBe(true);
    expect(slot.snapshot()).toEqual({ code: null, generation: 3 });
    expect(slot.pending()).toBeNull();
  });
});

describe("share handoff delivery", () => {
  it("keeps a pre-ready macOS open-url delivery pending without a window action", () => {
    const slot = createShareHandoffIntentSlot();

    expect(receiveShareHandoffArguments([VALID_URL], slot)).toBe(true);
    expect(slot.pending()).toBe(CODE_A);
  });

  it("delivers a casing variant as only the unchanged code", () => {
    const slot = createShareHandoffIntentSlot();
    const rawArgument = CASE_VARIANT_URLS[2][1];

    expect(receiveShareHandoffArguments([rawArgument], slot)).toBe(true);
    expect(slot.pending()).toBe(CODE_A);
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
    expect(slot.pending()).toBe(CODE_A);
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
    expect(slot.pending()).toBe(CODE_A);
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
