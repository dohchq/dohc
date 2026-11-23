import { mountFigure } from "./figure-view";

const host = document.querySelector<HTMLElement>("[data-engine-host]");
export const engineLoadFinished =
  host && "IntersectionObserver" in window
    ? new Promise<void>((resolve) => mountFigure(host, "engine", resolve))
    : Promise.resolve();
