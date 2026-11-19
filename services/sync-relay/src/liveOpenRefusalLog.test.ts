import { expect, it } from "vitest";
import {
  createLiveOpenRefusalLog,
  liveOpenFailureWords,
  LiveTicketFailure,
} from "./liveOpenRefusalLog";

it("writes each reason at most once a minute, with how often it applied since", () => {
  const lines: string[] = [];
  let now = 1_000_000;
  const refused = createLiveOpenRefusalLog(
    (line) => lines.push(line),
    () => now,
  );
  refused("the host takes no opens yet");
  refused("the host takes no opens yet");
  refused("threw: Error");
  now += 59_000;
  refused("the host takes no opens yet");
  now += 1_000;
  refused("the host takes no opens yet");
  expect(lines).toEqual([
    "[sync-relay] live open told to try again: the host takes no opens yet (1x)",
    "[sync-relay] live open told to try again: threw: Error (1x)",
    "[sync-relay] live open told to try again: the host takes no opens yet (3x)",
  ]);
});

it("shows a known failure's own sentence, also once the mint has wrapped it, and only the class of any other", () => {
  const known = new Error("Service document activation is incomplete.");
  expect(liveOpenFailureWords(known)).toBe("Service document activation is incomplete.");
  expect(liveOpenFailureWords(new LiveTicketFailure(known))).toBe(
    "Service document activation is incomplete.",
  );
  // A message this service did not write can name a file or hold a key, so it never reaches the log.
  const other = new TypeError("Cannot read /srv/notes/private-plan.md with key K7tN9TMwIopGHUhP");
  expect(liveOpenFailureWords(other)).toBe("TypeError");
  const wrapped = new LiveTicketFailure(other);
  expect(liveOpenFailureWords(wrapped)).toBe("TypeError");
  // The wrapper keeps the words and nothing else of the cause.
  expect(wrapped.cause).toBeUndefined();
  expect(
    JSON.stringify({ ...wrapped, message: wrapped.message, stack: wrapped.stack }),
  ).not.toContain("K7tN9TMwIopGHUhP");
});
