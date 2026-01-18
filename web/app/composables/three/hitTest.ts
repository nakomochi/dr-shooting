import * as THREE from "three";

export type HitTestHandle = {
  /** Start hit test */
  start: (session: XRSession) => Promise<boolean>;
  /** Get hit position for current frame */
  getHitPosition: (frame: XRFrame) => THREE.Vector3 | null;
  /** Create anchor at hit position */
  createAnchor: (frame: XRFrame) => Promise<XRAnchor | null>;
  /** Get reference space */
  getReferenceSpace: () => XRReferenceSpace | null;
  /** Whether hit test is available */
  isAvailable: () => boolean;
  /** Release resources */
  dispose: () => void;
};

/**
 * WebXR Hit Test utility
 * Manages surface detection and anchor creation
 */
export const createHitTest = (): HitTestHandle => {
  let hitTestSource: XRHitTestSource | null = null;
  let referenceSpace: XRReferenceSpace | null = null;
  let available = false;

  const start = async (session: XRSession): Promise<boolean> => {
    try {
      referenceSpace = await session.requestReferenceSpace("local");
      const viewerSpace = await session.requestReferenceSpace("viewer");

      hitTestSource = (await session.requestHitTestSource!({
        space: viewerSpace,
      })) ?? null;

      available = true;
      console.log("[HitTest] Started successfully");
      return true;
    } catch (e) {
      console.warn("[HitTest] Not available:", e);
      available = false;
      return false;
    }
  };

  const getHitPosition = (frame: XRFrame): THREE.Vector3 | null => {
    if (!hitTestSource || !referenceSpace) return null;

    try {
      const hitTestResults = frame.getHitTestResults(hitTestSource);
      if (hitTestResults.length === 0) return null;

      const hit = hitTestResults[0]!;
      const pose = hit.getPose(referenceSpace);
      if (!pose) return null;

      const { position } = pose.transform;
      return new THREE.Vector3(position.x, position.y, position.z);
    } catch (e) {
      return null;
    }
  };

  const createAnchor = async (frame: XRFrame): Promise<XRAnchor | null> => {
    if (!hitTestSource || !referenceSpace) return null;

    try {
      const hitTestResults = frame.getHitTestResults(hitTestSource);
      if (hitTestResults.length === 0) return null;

      const hit = hitTestResults[0]!;

      if (typeof hit.createAnchor !== "function") {
        console.warn("[HitTest] createAnchor not supported");
        return null;
      }

      const anchor = await hit.createAnchor();
      console.log("[HitTest] Created anchor");
      return anchor || null;
    } catch (e) {
      console.warn("[HitTest] Anchor creation failed:", e);
      return null;
    }
  };

  const getReferenceSpace = () => referenceSpace;
  const isAvailable = () => available;

  const dispose = () => {
    if (hitTestSource) {
      hitTestSource.cancel();
      hitTestSource = null;
    }
    referenceSpace = null;
    available = false;
    console.log("[HitTest] Disposed");
  };

  return {
    start,
    getHitPosition,
    createAnchor,
    getReferenceSpace,
    isAvailable,
    dispose,
  };
};
