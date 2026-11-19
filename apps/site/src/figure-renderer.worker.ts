import { renderFigure } from "./figure-renderer";
import type { FigureRequest, FigureResponse } from "./figure-messages";

let player: ReturnType<typeof renderFigure> | undefined;
const send = (message: FigureResponse) => self.postMessage(message);
self.onmessage = ({ data }: MessageEvent<FigureRequest>) => {
  try {
    if (data.type === "init") {
      player = renderFigure(
        data.canvas,
        data.kind,
        data.pixelRatio,
        data.view,
        data.lighting,
        () => send({ type: "rendered" }),
        (message) => send({ type: "error", message }),
      );
    } else player?.command(data);
  } catch (error) {
    send({ type: "error", message: String(error) });
  }
};
