// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  isShareAccess,
  useLocalPeople,
  type AnsweredPerson,
  type ListedPerson,
} from "./sharePerson";

const ana: AnsweredPerson = {
  shareId: "share-ana",
  grantId: "ana",
  name: "ana@dohc.test",
  email: "ana@dohc.test",
  access: "view",
  generation: 1,
};

function people(scope: string, listing: readonly ListedPerson[], read: boolean) {
  return renderHook((input) => useLocalPeople(input.scope, input.listing, input.read), {
    initialProps: { scope, listing, read },
  });
}

it("keeps a person a list held when the list is reset before it is read again", () => {
  const hook = people("plan", [], true);
  act(() => hook.result.current.keep(ana));
  hook.rerender({ scope: "plan", listing: [ana], read: true });

  hook.rerender({ scope: "plan", listing: [], read: false });
  hook.rerender({ scope: "plan", listing: [ana], read: true });

  expect(hook.result.current.retired).toEqual([]);
});

it("retires a person a list held once a list that was read leaves them out", () => {
  const hook = people("plan", [], true);
  act(() => hook.result.current.keep(ana));
  hook.rerender({ scope: "plan", listing: [ana], read: true });

  hook.rerender({ scope: "plan", listing: [], read: true });

  expect(hook.result.current.retired).toEqual(["ana"]);
});

it("starts again when Share comes back to a selection, and drops the first visit's late answers", () => {
  const hook = people("plan", [], true);
  const firstVisit = hook.result.current;
  act(() => firstVisit.keep(ana));
  expect(hook.result.current.unlisted([])).toEqual([ana]);

  hook.rerender({ scope: "budget", listing: [], read: true });
  hook.rerender({ scope: "plan", listing: [], read: true });
  expect(hook.result.current.unlisted([])).toEqual([]);

  act(() => firstVisit.retire("ana"));
  act(() => firstVisit.keep({ ...ana, access: "edit", generation: 2 }));
  expect(hook.result.current.retired).toEqual([]);
  expect(hook.result.current.unlisted([])).toEqual([]);

  act(() => hook.result.current.keep(ana));
  expect(hook.result.current.unlisted([])).toEqual([ana]);
});

it("takes only the three levels as a share's access, and no inherited name", () => {
  expect(["view", "comment", "edit"].every(isShareAccess)).toBe(true);
  expect(
    ["toString", "constructor", "hasOwnProperty", "__proto__", "owner", ""].some(isShareAccess),
  ).toBe(false);
  expect(isShareAccess(null)).toBe(false);
});

it("drops an answer that arrives for a selection Share has left", () => {
  const hook = people("plan", [], true);
  const forPlan = hook.result.current;
  hook.rerender({ scope: "budget", listing: [], read: true });
  act(() => hook.result.current.keep({ ...ana, access: "edit", generation: 2 }));

  act(() => forPlan.retire("ana"));
  act(() => forPlan.keep(ana));

  expect(hook.result.current.retired).toEqual([]);
  expect(hook.result.current.unlisted([])).toEqual([{ ...ana, access: "edit", generation: 2 }]);
});
