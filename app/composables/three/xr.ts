import type { WebGLRenderer } from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import { ARButton } from "three/examples/jsm/webxr/ARButton.js";

/** XR モード指定。vr: VRButton, ar: ARButton を使う */
export type XRMode = "vr" | "ar";

/**
 * WebXR を有効化し、VR/AR ボタンを DOM に追加する。
 * 返却する関数でボタンを破棄できる。
 */
export const setupXR = (renderer: WebGLRenderer, mode: XRMode = "vr") => {
  renderer.xr.enabled = true;

  const button =
    mode === "ar"
      ? ARButton.createButton(renderer, { requiredFeatures: ["hit-test"] })
      : VRButton.createButton(renderer);

  document.body.appendChild(button);

  return () => button.remove();
};
