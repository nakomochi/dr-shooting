import * as THREE from "three";
import { createCameraCapture, type CameraCaptureHandle } from "./cameraCapture";
import { createMaskOverlay, type MaskOverlayHandle } from "./maskOverlay";
import { createHitTest, type HitTestHandle } from "./hitTest";
import { requestSegmentation } from "../segmentation";
import type { RoomMeshHandle } from "./roomMesh";

export type SegmentationInitHandle = {
  /** Call at XR session start, before game begins */
  initialize: (frame?: XRFrame) => Promise<void>;
  /** Create anchors for all masks (call once after initialization, in XR frame callback) */
  createAnchors: (frame: XRFrame) => Promise<void>;
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
  /** Fallback distance when mesh raycast fails (default: 2.0) */
  maskDistance?: number;
  /** Passthrough camera FOV in degrees (default: auto-detect or 97) */
  cameraFov?: number;
  /** Scale adjustment factor (default: 1.0) */
  scaleFactor?: number;
  /** X offset (default: 0) */
  offsetX?: number;
  /** Y offset (default: 0) */
  offsetY?: number;
  /** Room mesh handle for depth raycasting */
  roomMesh?: RoomMeshHandle | null;
  /** Whether to use mesh-based positioning (default: true if roomMesh provided) */
  useMeshPositioning?: boolean;
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
    roomMesh = null,
    useMeshPositioning = true,
  } = options;

  // Raycaster for mesh intersection
  const raycaster = new THREE.Raycaster();

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

      // Get room meshes for raycasting
      const meshObjects = roomMesh?.getMeshes() ?? [];
      const canUseMesh = useMeshPositioning && meshObjects.length > 0;
      console.log(`[SegmentationInit] Mesh positioning: ${canUseMesh ? 'enabled' : 'disabled'} (${meshObjects.length} meshes)`);

      // Helper: Raycast to mesh and get intersection point + normal
      const raycastToMesh = (
        origin: THREE.Vector3,
        direction: THREE.Vector3
      ): { point: THREE.Vector3; normal: THREE.Vector3; distance: number } | null => {
        if (!canUseMesh) return null;

        raycaster.set(origin, direction.clone().normalize());
        const intersects = raycaster.intersectObjects(meshObjects, false);

        if (intersects.length > 0) {
          const hit = intersects[0]!;
          const normal = hit.face?.normal?.clone() ?? new THREE.Vector3(0, 0, 1);
          // Transform normal from object space to world space
          normal.transformDirection(hit.object.matrixWorld);
          return {
            point: hit.point.clone(),
            normal,
            distance: hit.distance,
          };
        }
        return null;
      };

      // Helper: Calculate quaternion to make plane face opposite to surface normal
      // (i.e., plane's back faces the wall, front faces the camera)
      const quaternionFromNormal = (normal: THREE.Vector3): THREE.Quaternion => {
        // Plane's default normal is (0, 0, 1)
        // We want the plane to face away from the wall (opposite of surface normal)
        const targetDir = normal.clone().negate();
        const defaultNormal = new THREE.Vector3(0, 0, 1);
        const quaternion = new THREE.Quaternion();
        quaternion.setFromUnitVectors(defaultNormal, targetDir);
        return quaternion;
      };

      for (const mask of result.masks) {
        let position: THREE.Vector3;
        let size: THREE.Vector2;
        let quaternion: THREE.Quaternion;

        if (mask.bbox) {
          const [x1, y1, x2, y2] = mask.bbox;

          // Normalize image coordinates to -0.5 ~ 0.5 range + apply offset
          const normX = (x1 + x2) / 2 / imgWidth - 0.5 + offsetX;
          const normY = -((y1 + y2) / 2 / imgHeight - 0.5) + offsetY;

          // Calculate ray direction from camera through bbox center
          const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(captureQuaternion);
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(captureQuaternion);
          const up = new THREE.Vector3(0, 1, 0).applyQuaternion(captureQuaternion);

          // FOV-based angular offset
          const angleX = normX * fovRad;
          const angleY = normY * fovRad / aspectRatio;

          // Ray direction considering FOV
          const rayDir = forward.clone()
            .add(right.clone().multiplyScalar(Math.tan(angleX)))
            .add(up.clone().multiplyScalar(Math.tan(angleY)))
            .normalize();

          // Try raycast to mesh
          const hitResult = raycastToMesh(capturePosition, rayDir);

          if (hitResult) {
            // Use mesh intersection for accurate depth and orientation
            const actualDistance = hitResult.distance;

            // Calculate view dimensions at actual distance
            const viewHeightAtDist = 2 * actualDistance * Math.tan(fovRad / 2) * scaleFactor;
            const viewWidthAtDist = viewHeightAtDist * aspectRatio;

            // Position mask slightly in front of wall (5cm offset to avoid z-fighting)
            position = hitResult.point.clone().add(hitResult.normal.clone().multiplyScalar(0.05));

            // Calculate size based on actual distance
            const bboxWidth = ((x2 - x1) / imgWidth) * viewWidthAtDist;
            const bboxHeight = ((y2 - y1) / imgHeight) * viewHeightAtDist;
            size = new THREE.Vector2(bboxWidth, bboxHeight);

            // Orient mask parallel to wall surface
            quaternion = quaternionFromNormal(hitResult.normal);

            console.log(`[SegmentationInit] Mask ${mask.id}: mesh hit at ${actualDistance.toFixed(2)}m, normal: [${hitResult.normal.toArray().map(n => n.toFixed(2)).join(', ')}]`);
          } else {
            // Fallback: use fixed distance (original behavior)
            const viewHeight = 2 * maskDistance * Math.tan(fovRad / 2) * scaleFactor;
            const viewWidth = viewHeight * aspectRatio;

            position = capturePosition.clone()
              .add(forward.clone().multiplyScalar(maskDistance))
              .add(right.clone().multiplyScalar(normX * viewWidth))
              .add(up.clone().multiplyScalar(normY * viewHeight));

            const bboxWidth = ((x2 - x1) / imgWidth) * viewWidth;
            const bboxHeight = ((y2 - y1) / imgHeight) * viewHeight;
            size = new THREE.Vector2(bboxWidth, bboxHeight);

            // Face camera (original behavior)
            quaternion = captureQuaternion.clone();

            console.log(`[SegmentationInit] Mask ${mask.id}: no mesh hit, using fallback distance ${maskDistance}m`);
          }
        } else {
          // No bbox - use full view at fixed distance
          const viewHeight = 2 * maskDistance * Math.tan(fovRad / 2) * scaleFactor;
          const viewWidth = viewHeight * aspectRatio;
          const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(captureQuaternion);
          position = capturePosition.clone().add(forward.multiplyScalar(maskDistance));
          size = new THREE.Vector2(viewWidth, viewHeight);
          quaternion = captureQuaternion.clone();
        }

        await maskOverlay.addMask(
          mask.data,
          mask.color,
          position,
          size,
          mask.id,
          quaternion,
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

  let anchorsCreated = false;

  const createAnchors = async (frame: XRFrame): Promise<void> => {
    if (!maskOverlay || !hitTest || anchorsCreated) return;

    const referenceSpace = hitTest.getReferenceSpace();
    if (!referenceSpace) {
      console.warn("[SegmentationInit] Cannot create anchors: no reference space");
      return;
    }

    await maskOverlay.createAnchors(frame, referenceSpace);
    anchorsCreated = true;
    console.log("[SegmentationInit] Anchors created for all masks");
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
    anchorsCreated = false;
    console.log("[SegmentationInit] Disposed");
  };

  return {
    initialize,
    createAnchors,
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
