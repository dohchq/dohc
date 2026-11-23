import { mountFigure } from "./figure-view";

const host = document.querySelector<HTMLElement>("[data-drive-model-host]");
if (host) mountFigure(host, "drive");
