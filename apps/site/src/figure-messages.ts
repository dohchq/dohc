export type FigureKind = "engine" | "drive" | "wheel";
export type FigureView = {
  width: number;
  height: number;
  visible: boolean;
  animate: boolean;
  dark: boolean;
};
export type FigureCommand =
  | { type: "view"; view: FigureView }
  | { type: "orbit"; theta: number; phi: number };
export type FigureRequest =
  | {
      type: "init";
      canvas: OffscreenCanvas;
      kind: FigureKind;
      pixelRatio: number;
      view: FigureView;
      lighting: ArrayBuffer;
    }
  | FigureCommand;
export type FigureResponse = { type: "rendered" } | { type: "error"; message: string };
