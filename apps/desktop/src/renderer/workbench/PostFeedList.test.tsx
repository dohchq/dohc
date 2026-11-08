// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PostFeedList } from "./PostFeedList";

// The real list, not the shared mock: where `empty` sits depends on the style
// LegendList gives its content.
function feed(items: string[]) {
  return (
    <PostFeedList
      items={items}
      itemKey={(item) => item}
      renderItem={(item) => <p>{item}</p>}
      header={<p>Composer</p>}
      empty={<p data-testid="empty">No posts yet.</p>}
      topPadding={12}
      bottomPadding={64}
    />
  );
}

describe("PostFeedList", () => {
  it("gives `empty` the height below the header until the first row arrives", () => {
    const view = render(feed([]));
    const slot = screen.getByTestId("empty").parentElement!;
    const content = slot.parentElement!;
    const list = content.parentElement!;
    expect(slot.className.split(" ")).toContain("flex-1");
    expect(content.style).toMatchObject({ display: "flex", flexDirection: "column", minHeight: "100%" });
    expect([list.style.paddingTop, list.style.paddingBottom]).toEqual(["", ""]);

    view.rerender(feed(["First post"]));
    expect(screen.queryByTestId("empty")).toBeNull();
    expect(content.style.display).toBe("block");
    expect([list.style.paddingTop, list.style.paddingBottom]).toEqual(["12px", "64px"]);
  });
});
