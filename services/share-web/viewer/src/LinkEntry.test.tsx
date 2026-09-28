// @vitest-environment jsdom
import {act} from "react";
import {createRoot} from "react-dom/client";
import {expect, it} from "vitest";
import {LinkEntry} from "./LinkEntry";
it("names the authorized link target with its access, without inventing a sharer", async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
  const node = document.createElement("div"), root = createRoot(node);
  try {
    await act(async () => root.render(<LinkEntry meta={{subjectName: "Trip", access: "view", effectiveSelector: {paths: ["trip"], versionId: null, access: "view"}, lastSettledAtMs: null, lastSettledKnown: false}} hasFiles={true} canEditFile={false}/>));
    expect(node.textContent).toContain("Trip"); expect(node.textContent).toContain("You can read files and comments"); expect(node.textContent).not.toContain("dohc user");
  } finally {await act(async () => root.unmount());}
});
