import { createLayoutEngine, type LayoutRequest } from "./graphLayout";

const engine = createLayoutEngine(
  (frame) => self.postMessage(frame, { transfer: [frame.positions.buffer] }),
  (run) => setTimeout(run, 0),
);

self.onmessage = ({ data }: MessageEvent<LayoutRequest>) => engine.receive(data);
