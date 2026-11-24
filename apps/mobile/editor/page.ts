// The page script the app's web views load, bundled by scripts/build-editor.mjs. The app sets `__dohcPage`, before
// this script runs or after.
import { post } from "./bridge";
import { mountDocument, type PageConfig } from "./document";

const host = window as Window & { __dohcPage?: PageConfig };
// When the script starts running, to split the time to first text into the web view's start and the render.
post("started", { at: Date.now() });
// Inter loads before the page draws, so its text never swaps or hides: all three faces, so every property, line and
// letter typed later has its face. A spare editor loads them before any page, and says so. If they can't load within
// 5 seconds of the page arriving, the page doesn't draw, and the app shows "dohc could not open this file." with Try
// again. A large file's text is monospace only, so it doesn't wait.
const fonts = document.fonts
  .load('1rem "Inter Variable"', "aĀạ")
  .then((faces) => faces.length === 3)
  .catch(() => false);
void fonts.then((loaded) => {
  if (loaded) post("fontsLoaded");
});
function start(page: PageConfig) {
  if (page.large) mountDocument(page);
  else
    void Promise.race([
      fonts,
      new Promise<boolean>((done) => setTimeout(() => done(false), 5000)),
    ]).then((loaded) => {
      if (!loaded) {
        post("fontsFailed", { at: Date.now() });
        return;
      }
      post("fonts", { at: Date.now() });
      mountDocument(page);
    });
}
if (host.__dohcPage) start(host.__dohcPage);
else
  Object.defineProperty(host, "__dohcPage", {
    configurable: true,
    set(page: PageConfig) {
      Object.defineProperty(host, "__dohcPage", { value: page, configurable: true });
      start(page);
    },
  });
