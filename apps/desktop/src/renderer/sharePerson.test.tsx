// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useLocalPeople, type AnsweredPerson, type ListedPerson } from "./sharePerson";

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
