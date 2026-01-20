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
  /** Get captured image data as base64 (for calibration) */
  getCapturedImageData: () => string | null;
  /** Get camera position at capture time (for calibration) */
  getCapturePosition: () => THREE.Vector3 | null;
  /** Get camera quaternion at capture time (for calibration) */
  getCaptureQuaternion: () => THREE.Quaternion | null;
  /** Release resources */
  dispose: () => void;
};

export type DepthMode = 'none' | 'center' | 'multi-point';

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
  /** Capture only mode - skip segmentation API, just capture image (for calibration) */
  captureOnly?: boolean;
  /** Depth mode: 'none' = fixed distance, 'center' = raycast at mask center, 'multi-point' = raycast at multiple points (default: 'center') */
  depthMode?: DepthMode;
  /** Number of sample points for multi-point depth mode (default: 5) */
  depthSampleCount?: number;
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
    captureOnly = false,
    depthMode = 'center',
    depthSampleCount = 5,
  } = options;

  // Raycaster for mesh intersection
  const raycaster = new THREE.Raycaster();

  let ready = false;
  let initializing = false;
  let maskOverlay: MaskOverlayHandle | null = null;
  let hitTest: HitTestHandle | null = null;
  let combinedInpaintData: string | null = null;
  let imageSize: [number, number] | null = null;
  let capturedImageData: string | null = null;
  let storedCapturePosition: THREE.Vector3 | null = null;
  let storedCaptureQuaternion: THREE.Quaternion | null = null;
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

      // Store for external access (e.g., imageCalibration)
      storedCapturePosition = capturePosition.clone();
      storedCaptureQuaternion = captureQuaternion.clone();

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

      // Store captured image for calibration
      capturedImageData = `data:image/jpeg;base64,${imageBase64}`;

      // In capture-only mode, skip segmentation API and finish immediately
      if (captureOnly) {
        console.log("[SegmentationInit] Capture-only mode - skipping segmentation");
        // Set a default image size from the captured image
        // We'll estimate based on typical camera resolution
        const img = new Image();
        img.src = capturedImageData;
        await new Promise<void>((resolve) => {
          img.onload = () => {
            imageSize = [img.width, img.height];
            resolve();
          };
          img.onerror = () => {
            // Fallback to typical Quest 3 camera resolution
            imageSize = [1280, 960];
            resolve();
          };
        });
        console.log(`[SegmentationInit] Capture complete: ${imageSize![0]}x${imageSize![1]}`);
        ready = true;
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

      // Helper: Get ray origin for parallel projection
      // Instead of shooting rays from camera at angles, we shoot parallel rays from offset positions
      const viewHeight = 2 * maskDistance * Math.tan(fovRad / 2);
      const viewWidth = viewHeight * aspectRatio;

      const getParallelRayOrigin = (
        imgX: number,
        imgY: number,
        right: THREE.Vector3,
        up: THREE.Vector3
      ): THREE.Vector3 => {
        const normX = imgX / imgWidth - 0.5;
        const normY = -(imgY / imgHeight - 0.5);
        // Map 2D screen position to 3D space using calibrated scale
        return capturePosition.clone()
          .add(right.clone().multiplyScalar(normX * viewWidth * scaleFactor))
          .add(up.clone().multiplyScalar(normY * viewHeight * scaleFactor));
      };

      // Minimum distance to prevent masks from being too close
      const minDistance = 0.5;

      // Helper: Get depth for a mask using center point raycast (parallel projection)
      const getDepthCenter = (
        bbox: [number, number, number, number],
        forward: THREE.Vector3,
        right: THREE.Vector3,
        up: THREE.Vector3
      ): { distance: number; normal: THREE.Vector3 | null; point: THREE.Vector3 | null } => {
        const [x1, y1, x2, y2] = bbox;
        const centerX = (x1 + x2) / 2;
        const centerY = (y1 + y2) / 2;
        // Parallel projection: ray origin is offset, direction is always forward
        const rayOrigin = getParallelRayOrigin(centerX, centerY, right, up);
        const hit = raycastToMesh(rayOrigin, forward);
        if (hit) {
          // If too close, fallback to default distance
          if (hit.distance < minDistance) {
            console.log(`[SegmentationInit] Hit too close (${hit.distance.toFixed(2)}m), using fallback`);
            return { distance: maskDistance, normal: null, point: null };
          }
          return { distance: hit.distance, normal: hit.normal, point: hit.point };
        }
        return { distance: maskDistance, normal: null, point: null };
      };

      // Helper: Get depth for a mask using multiple point raycast (parallel projection)
      const getDepthMultiPoint = (
        bbox: [number, number, number, number],
        forward: THREE.Vector3,
        right: THREE.Vector3,
        up: THREE.Vector3,
        sampleCount: number
      ): { distance: number; normal: THREE.Vector3 | null; point: THREE.Vector3 | null } => {
        const [x1, y1, x2, y2] = bbox;
        const centerX = (x1 + x2) / 2;
        const centerY = (y1 + y2) / 2;
        const bboxW = x2 - x1;
        const bboxH = y2 - y1;
        const margin = 0.2; // 20% margin from edges

        // Sample points: center + 4 corners (with margin)
        const samplePoints = [
          { x: centerX, y: centerY }, // center
          { x: x1 + bboxW * margin, y: y1 + bboxH * margin }, // top-left
          { x: x2 - bboxW * margin, y: y1 + bboxH * margin }, // top-right
          { x: x1 + bboxW * margin, y: y2 - bboxH * margin }, // bottom-left
          { x: x2 - bboxW * margin, y: y2 - bboxH * margin }, // bottom-right
        ].slice(0, sampleCount);

        const validHits: { distance: number; normal: THREE.Vector3; point: THREE.Vector3 }[] = [];
        for (const pt of samplePoints) {
          // Parallel projection: ray origin is offset, direction is always forward
          const rayOrigin = getParallelRayOrigin(pt.x, pt.y, right, up);
          const hit = raycastToMesh(rayOrigin, forward);
          if (hit) {
            validHits.push({ distance: hit.distance, normal: hit.normal, point: hit.point });
          }
        }

        if (validHits.length === 0) {
          return { distance: maskDistance, normal: null, point: null };
        }

        // Average distance
        const avgDistance = validHits.reduce((sum, h) => sum + h.distance, 0) / validHits.length;

        // If average distance is too close, fallback to default distance
        if (avgDistance < minDistance) {
          console.log(`[SegmentationInit] Multi-point hit too close (${avgDistance.toFixed(2)}m), using fallback`);
          return { distance: maskDistance, normal: null, point: null };
        }

        // Average normal
        const avgNormal = new THREE.Vector3();
        for (const hit of validHits) {
          avgNormal.add(hit.normal);
        }
        avgNormal.normalize();

        // Use center point (or first valid hit) for position calculation
        const centerHit = validHits[0]!;

        return { distance: avgDistance, normal: avgNormal, point: centerHit.point };
      };

      for (const mask of result.masks) {
        let position: THREE.Vector3;
        let size: THREE.Vector2;
        let quaternion: THREE.Quaternion;

        // Camera direction vectors (shared for all cases)
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(captureQuaternion);
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(captureQuaternion);
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(captureQuaternion);

        if (mask.bbox) {
          const [x1, y1, x2, y2] = mask.bbox;

          // Normalize image coordinates to -0.5 ~ 0.5 range (NO offset here - applied separately like imageCalibration)
          const normX = (x1 + x2) / 2 / imgWidth - 0.5;
          const normY = -((y1 + y2) / 2 / imgHeight - 0.5);

          // Get depth based on depthMode
          let depthResult: { distance: number; normal: THREE.Vector3 | null; point: THREE.Vector3 | null };

          if (depthMode === 'multi-point' && canUseMesh) {
            depthResult = getDepthMultiPoint(mask.bbox, forward, right, up, depthSampleCount);
          } else if (depthMode === 'center' && canUseMesh) {
            depthResult = getDepthCenter(mask.bbox, forward, right, up);
          } else {
            // 'none' mode or mesh not available: use fixed distance
            depthResult = { distance: maskDistance, normal: null, point: null };
          }

          const actualDistance = depthResult.distance;
          const surfaceNormal = depthResult.normal;

          // Calculate view dimensions at actual distance
          const viewHeightAtDist = 2 * actualDistance * Math.tan(fovRad / 2);
          const viewWidthAtDist = viewHeightAtDist * aspectRatio;

          // Use same position calculation as fallback, but with depth from raycast
          // This ensures XY position matches the calibrated image, only Z (depth) changes
          const basePosition = capturePosition.clone()
            .add(forward.clone().multiplyScalar(actualDistance))
            .add(right.clone().multiplyScalar(normX * viewWidthAtDist * scaleFactor))
            .add(up.clone().multiplyScalar(normY * viewHeightAtDist * scaleFactor));

          // Apply offset like imageCalibration: offset * distance (world space offset)
          const offsetWorld = new THREE.Vector3()
            .add(right.clone().multiplyScalar(offsetX * actualDistance))
            .add(up.clone().multiplyScalar(offsetY * actualDistance));
          position = basePosition.add(offsetWorld);

          // Size without scaleFactor (scaleFactor applied via mesh.scale later)
          const bboxWidth = ((x2 - x1) / imgWidth) * viewWidthAtDist;
          const bboxHeight = ((y2 - y1) / imgHeight) * viewHeightAtDist;
          size = new THREE.Vector2(bboxWidth, bboxHeight);

          // Face camera
          quaternion = captureQuaternion.clone();

          if (depthResult.point) {
            console.log(`[SegmentationInit] Mask ${mask.id}: depth ${actualDistance.toFixed(2)}m (mode=${depthMode})`);
          } else {
            console.log(`[SegmentationInit] Mask ${mask.id}: fallback distance ${actualDistance.toFixed(2)}m (mode=${depthMode})`);
          }
        } else {
          // No bbox - use full view at fixed distance
          const viewHeight = 2 * maskDistance * Math.tan(fovRad / 2);
          const viewWidth = viewHeight * aspectRatio;
          position = capturePosition.clone().add(forward.multiplyScalar(maskDistance));
          size = new THREE.Vector2(viewWidth, viewHeight);
          quaternion = captureQuaternion.clone();
        }

        const addedMask = await maskOverlay.addMask(
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

        // Apply scaleFactor via mesh.scale (same as imageCalibration's plane.scale.setScalar)
        if (addedMask && scaleFactor !== 1.0) {
          addedMask.mesh.scale.setScalar(scaleFactor);
        }
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
  const getCapturedImageData = () => capturedImageData;
  const getCapturePosition = () => storedCapturePosition;
  const getCaptureQuaternion = () => storedCaptureQuaternion;

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
    getCapturedImageData,
    getCapturePosition,
    getCaptureQuaternion,
    dispose,
  };
};
