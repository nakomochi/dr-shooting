import type { WebGLRenderer } from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";

/** XR mode: vr uses VRButton, ar uses ARButton */
export type XRMode = "vr" | "ar";

/**
 * Create custom AR button
 */
const createCustomARButton = (renderer: WebGLRenderer): HTMLButtonElement => {
  const button = document.createElement("button");
  button.style.cssText = `
    position: absolute;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    padding: 12px 24px;
    border: 1px solid #fff;
    border-radius: 4px;
    background: rgba(0,0,0,0.1);
    color: #fff;
    font: normal 13px sans-serif;
    text-align: center;
    cursor: pointer;
    z-index: 999;
  `;
  button.textContent = "START AR";

  let currentSession: XRSession | null = null;

  const onSessionStarted = async (session: XRSession) => {
    session.addEventListener("end", onSessionEnded);
    await renderer.xr.setSession(session);
    button.textContent = "STOP AR";
    currentSession = session;
  };

  const onSessionEnded = () => {
    currentSession?.removeEventListener("end", onSessionEnded);
    button.textContent = "START AR";
    currentSession = null;
  };

  button.onclick = async () => {
    if (currentSession === null) {
      try {
        const sessionInit: XRSessionInit = {
          requiredFeatures: ["local-floor"],
          optionalFeatures: ["hit-test", "anchors"],
        };

        console.log("[XR] Requesting AR session...");
        const session = await navigator.xr!.requestSession(
          "immersive-ar",
          sessionInit
        );

        const enabledFeatures = (session as any).enabledFeatures;
        console.log("[XR] Enabled features:", enabledFeatures);

        await onSessionStarted(session);
      } catch (e) {
        console.error("[XR] Failed to start AR session:", e);
      }
    } else {
      currentSession.end();
    }
  };

  return button;
};

/**
 * Enable WebXR and add VR/AR button to DOM.
 * Returns cleanup function to remove the button.
 */
export const setupXR = (renderer: WebGLRenderer, mode: XRMode = "vr") => {
  renderer.xr.enabled = true;

  const button =
    mode === "ar"
      ? createCustomARButton(renderer)
      : VRButton.createButton(renderer);

  document.body.appendChild(button);

  return () => button.remove();
};
