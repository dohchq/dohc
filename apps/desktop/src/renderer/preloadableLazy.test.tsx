// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { preloadableLazy } from "./preloadableLazy";

afterEach(cleanup);

function View(props: { name: string }) {
  return <p data-testid="view">{props.name}</p>;
}

function mount(Lazy: ReturnType<typeof preloadableLazy<{ name: string }>>) {
  render(
    <Suspense fallback={<p data-testid="loading" />}>
      <Lazy name="notes" />
    </Suspense>,
  );
}

describe("preloadableLazy", () => {
  it("shows a preloaded view in its first commit, without the loading state", async () => {
    const Lazy = preloadableLazy(() => Promise.resolve(View));
    await Lazy.preload();

    mount(Lazy);

    expect(screen.queryByTestId("loading")).toBeNull();
    expect(screen.getByTestId("view").textContent).toBe("notes");
  });

  it("loads a view nobody preloaded when it first renders", async () => {
    const Lazy = preloadableLazy(() => Promise.resolve(View));

    mount(Lazy);
    expect(screen.getByTestId("loading")).toBeTruthy();

    expect((await screen.findByTestId("view")).textContent).toBe("notes");
  });

  it("loads again on render after a preload failed", async () => {
    let attempts = 0;
    const Lazy = preloadableLazy(() =>
      ++attempts === 1 ? Promise.reject(new Error("offline")) : Promise.resolve(View),
    );
    await Lazy.preload();

    await act(async () => mount(Lazy));

    expect((await screen.findByTestId("view")).textContent).toBe("notes");
    expect(attempts).toBe(2);
  });
});
