import { mountFigure } from "./figure-view";

const path = document.querySelector<HTMLElement>("[data-missing-path]");
if (path && location.pathname !== "/") {
  let shown = location.pathname;
  try {
    shown = decodeURI(shown);
  } catch {
    /* Keep the encoded path. */
  }
  path.textContent = shown;
  path.classList.add("not-found-path");
}

const host = document.querySelector<HTMLElement>("[data-wheel-host]");
if (host) mountFigure(host, "wheel");
