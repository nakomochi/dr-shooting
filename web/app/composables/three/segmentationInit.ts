import * as THREE from "three";
import { createCameraCapture, type CameraCaptureHandle } from "./cameraCapture";
import { createMaskOverlay, type MaskOverlayHandle } from "./maskOverlay";
import { createHitTest, type HitTestHandle } from "./hitTest";
import { requestSegmentation } from "../segmentation";

export type SegmentationInitHandle = {
  /** Call at XR session start, before game begins */
  initialize: (frame?: XRFrame) => Promise<void>;
  /** Call every frame to update mask positions */
  update: (frame: XRFrame) => void;
  /** Show/hide segmentation overlay */
  setVisible: (visible: boolean) => void;
  /** Whether initialization is complete */
  isReady: () => boolean;
  /** Whether initialization is in progress */
  isInitializing: () => boolean;
  /** Get mask overlay handle for hit testing */
  getMaskOverlay: () => MaskOverlayHandle | null;
  /** Get combined inpainted image data (if using combined mode) */
  getCombinedInpaintData: () => string | null;
  /** Get image size [width, height] */
  getImageSize: () => [number, number] | null;
  /** Release resources */
  dispose: () => void;
};

export type SegmentationInitOptions = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  /** Segmentation API endpoint */
  segmentationEndpoint?: string;
  /** Mask opacity (default: 0.4) */
  maskOpacity?: number;
  /** Distance to place masks in meters (default: 2.0) */
  maskDistance?: number;
  /** Passthrough camera FOV in degrees (default: auto-detect or 97) */
  cameraFov?: number;
  /** Scale adjustment factor (default: 1.0) */
  scaleFactor?: number;
  /** X offset (default: 0) */
  offsetX?: number;
  /** Y offset (default: 0) */
  offsetY?: number;
};

/**
 * Segmentation initialization orchestrator
 * 1. Capture passthrough image
 * 2. Send to FastSAM server
 * 3. Display masks in 3D space
 */
export const createSegmentationInit = (
  options: SegmentationInitOptions
): SegmentationInitHandle => {
  const {
    scene,
    camera,
    renderer,
    segmentationEndpoint,
    maskOpacity = 0.4,
    maskDistance = 2.0,
    cameraFov,
    scaleFactor = 1.0,
    offsetX = 0,
    offsetY = 0,
  } = options;

  let ready = false;
  let initializing = false;
  let maskOverlay: MaskOverlayHandle | null = null;
  let hitTest: HitTestHandle | null = null;
  let combinedInpaintData: string | null = null;
  let imageSize: [number, number] | null = null;
  const cameraCapture: CameraCaptureHandle = createCameraCapture({ renderer });

  const initialize = async (frame?: XRFrame) => {
    if (initializing || ready) {
      console.log("[SegmentationInit] Already initialized or initializing");
      return;
    }

    initializing = true;
    console.log("[SegmentationInit] Starting initialization...");

    try {
      const session = renderer.xr.getSession();
      if (session) {
        hitTest = createHitTest();
        await hitTest.start(session);
      }

      console.log("[SegmentationInit] Initializing camera...");
      const cameraReady = await cameraCapture.initCamera();
      if (!cameraReady) {
        console.warn("[SegmentationInit] Camera not available, using canvas fallback");
      }

      console.log("[SegmentationInit] Capturing image...");
      const objectsToHide: THREE.Object3D[] = [];
      scene.traverse((obj) => {
        if (obj.visible && obj !== scene) {
          objectsToHide.push(obj);
          obj.visible = false;
        }
      });

      renderer.render(scene, camera);

      // Save camera position/orientation at capture time (used after server response)
      const xrCamera = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
      const capturePosition = xrCamera.position.clone();
      const captureQuaternion = xrCamera.quaternion.clone();

      console.log("[SegmentationInit] Capture camera position:", capturePosition.toArray());
      console.log("[SegmentationInit] Capture camera quaternion:", captureQuaternion.toArray());

      const imageBase64 = await cameraCapture.capture(frame);

      objectsToHide.forEach((obj) => {
        obj.visible = true;
      });

      if (!imageBase64) {
        console.error("[SegmentationInit] Failed to capture image");
        initializing = false;
        return;
      }

      console.log("[SegmentationInit] Requesting segmentation...");
      const result = await requestSegmentation(imageBase64, {
        endpoint: segmentationEndpoint,
        maxMasks: 20,
      });

      if (!result.success) {
        console.error("[SegmentationInit] Segmentation failed:", result.error);
        ready = true;
        initializing = false;
        return;
      }

      if (result.count === 0) {
        console.log("[SegmentationInit] No masks detected");
        ready = true;
        initializing = false;
        return;
      }

      console.log(`[SegmentationInit] Received ${result.count} masks`);

      // Store combined inpaint data and image size
      combinedInpaintData = result.combinedInpaintData ?? null;
      imageSize = result.imageSize;

      if (combinedInpaintData) {
        console.log("[SegmentationInit] Combined inpaint data received");
      }

      maskOverlay = createMaskOverlay({ scene, opacity: maskOpacity });

      const [imgWidth, imgHeight] = result.imageSize;
      const aspectRatio = imgWidth / imgHeight;

      const useFov = cameraFov ?? cameraCapture.getCameraFov() ?? 97;
      console.log(`[SegmentationInit] Using camera FOV: ${useFov}, scale: ${scaleFactor}, offset: (${offsetX}, ${offsetY})`);
      const fovRad = THREE.MathUtils.degToRad(useFov);
      const viewHeight = 2 * maskDistance * Math.tan(fovRad / 2) * scaleFactor;
      const viewWidth = viewHeight * aspectRatio;

      for (const mask of result.masks) {
        let position: THREE.Vector3;
        let size: THREE.Vector2;

        if (mask.bbox) {
          const [x1, y1, x2, y2] = mask.bbox;

          // Normalize image coordinates to -0.5 ~ 0.5 range + apply offset
          const normX = (x1 + x2) / 2 / imgWidth - 0.5 + offsetX;
          const normY = -((y1 + y2) / 2 / imgHeight - 0.5) + offsetY;

          const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(captureQuaternion);
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(captureQuaternion);
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(captureQuaternion);

          position = capturePosition.clone()
            .add(forward.multiplyScalar(maskDistance))
            .add(right.multiplyScalar(normX * viewWidth))
            .add(up.multiplyScalar(normY * viewHeight));

          const bboxWidth = ((x2 - x1) / imgWidth) * viewWidth;
          const bboxHeight = ((y2 - y1) / imgHeight) * viewHeight;
          size = new THREE.Vector2(bboxWidth, bboxHeight);
        } else {
          const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(captureQuaternion);
          position = capturePosition.clone().add(forward.multiplyScalar(maskDistance));
          size = new THREE.Vector2(viewWidth, viewHeight);
        }

        await maskOverlay.addMask(
          mask.data,
          mask.color,
          position,
          size,
          mask.id,
          captureQuaternion,
          mask.inpaint_data,
          mask.inpaint_bbox,
          mask.bbox ?? undefined
        );
      }

      ready = true;
      console.log(
        `[SegmentationInit] Initialization complete with ${maskOverlay.getMaskCount()} masks`
      );
    } catch (e) {
      console.error("[SegmentationInit] Initialization error:", e);
      ready = true;
    } finally {
      initializing = false;
    }
  };

  const update = (frame: XRFrame) => {
    if (!maskOverlay || !hitTest) return;

    const referenceSpace = hitTest.getReferenceSpace();
    if (referenceSpace) {
      maskOverlay.updateAnchors(frame, referenceSpace);
    }
  };

  const setVisible = (visible: boolean) => {
    maskOverlay?.setVisible(visible);
  };

  const isReady = () => ready;
  const isInitializing = () => initializing;
  const getMaskOverlay = () => maskOverlay;
  const getCombinedInpaintData = () => combinedInpaintData;
  const getImageSize = () => imageSize;

  const dispose = () => {
    maskOverlay?.dispose();
    hitTest?.dispose();
    cameraCapture.dispose();
    ready = false;
    initializing = false;
    console.log("[SegmentationInit] Disposed");
  };

  return {
    initialize,
    update,
    setVisible,
    isReady,
    isInitializing,
    getMaskOverlay,
    getCombinedInpaintData,
    getImageSize,
    dispose,
  };
};
