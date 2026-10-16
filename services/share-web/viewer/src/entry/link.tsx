import { mount } from "../mount";
import { App } from "../App";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

window.EXCALIDRAW_ASSET_PATH = "/s/assets/";

mount(<App />);
