export type EngineView = {
  width: number;
  height: number;
  theta: number;
  phi: number;
};

export type EngineWorkerRequest =
  | { type: 'init'; canvas: OffscreenCanvas; pixelRatio: number; studioUrl: string }
  | { type: 'view'; view: EngineView }
  | { type: 'visible'; visible: boolean };

export type EngineWorkerResponse =
  | { type: 'ready' }
  | { type: 'rendered' }
  | { type: 'error'; message: string; stack?: string };
