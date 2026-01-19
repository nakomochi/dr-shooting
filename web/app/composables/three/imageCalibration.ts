import * as THREE from "three";

export type ImageCalibrationParams = {
  offsetX: number;
  offsetY: number;
  scale: number;
};

export type ImageCalibrationOptions = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  imageData: string; // base64 image
  imageSize: [number, number];
  initialDistance: number;
  onComplete: (params: ImageCalibrationParams) => void;
  /** Initial offset X (from previous calibration) */
  initialOffsetX?: number;
  /** Initial offset Y (from previous calibration) */
  initialOffsetY?: number;
  /** Initial scale (from previous calibration) */
  initialScale?: number;
  /** Camera position at image capture time (from segmentationInit) */
  capturePosition?: THREE.Vector3;
  /** Camera quaternion at image capture time (from segmentationInit) */
  captureQuaternion?: THREE.Quaternion;
  /** Passthrough camera FOV in degrees (should match segmentationInit) */
  cameraFov?: number;
};

export type ImageCalibrationHandle = {
  start: () => void;
  update: (frame: XRFrame, deltaSec: number) => void;
  confirm: () => void;
  isActive: () => boolean;
  dispose: () => void;
};

/**
 * Image-based calibration mode
 * Display the captured image as a semi-transparent plane and let user align it with the real world
 */
export const createImageCalibration = (
  options: ImageCalibrationOptions
): ImageCalibrationHandle => {
  const {
    scene,
    camera,
    renderer,
    imageData,
    imageSize,
    initialDistance,
    onComplete,
    initialOffsetX = 0,
    initialOffsetY = 0,
    initialScale = 1.0,
    capturePosition: providedCapturePosition,
    captureQuaternion: providedCaptureQuaternion,
    cameraFov,
  } = options;

  let active = false;
  let plane: THREE.Mesh | null = null;
  let material: THREE.MeshBasicMaterial | null = null;

  // Current calibration state (start from initial values)
  let offsetX = initialOffsetX;
  let offsetY = initialOffsetY;
  let scale = initialScale;

  // Stored camera pose at start
  let capturePosition = new THREE.Vector3();
  let captureQuaternion = new THREE.Quaternion();

  // Control speeds
  const MOVE_SPEED = 0.3;
  const SCALE_SPEED = 0.5;
  const DEADZONE = 0.15;

  const applyDeadzone = (value: number): number => {
    if (Math.abs(value) < DEADZONE) return 0;
    return (value - Math.sign(value) * DEADZONE) / (1 - DEADZONE);
  };

  const start = () => {
    if (active) return;

    // Use provided capture pose if available (from segmentationInit), otherwise use current camera pose
    if (providedCapturePosition && providedCaptureQuaternion) {
      capturePosition.copy(providedCapturePosition);
      captureQuaternion.copy(providedCaptureQuaternion);
      console.log("[ImageCalibration] Using provided capture pose from segmentationInit");
      console.log(`[ImageCalibration] quaternion = [${captureQuaternion.x.toFixed(4)}, ${captureQuaternion.y.toFixed(4)}, ${captureQuaternion.z.toFixed(4)}, ${captureQuaternion.w.toFixed(4)}]`);
    } else {
      const xrCamera = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
      capturePosition.copy(xrCamera.position);
      captureQuaternion.copy(xrCamera.quaternion);
      console.log("[ImageCalibration] Using current camera pose");
    }

    // Create texture from image data
    const texture = new THREE.TextureLoader().load(imageData);
    texture.colorSpace = THREE.SRGBColorSpace;

    // Calculate plane size based on FOV and distance
    // Use provided cameraFov (passthrough camera FOV) if available, otherwise fall back to THREE.js camera FOV
    const [imgWidth, imgHeight] = imageSize;
    const aspectRatio = imgWidth / imgHeight;
    const useFov = cameraFov ?? camera.fov;
    const fovRad = THREE.MathUtils.degToRad(useFov);
    const planeHeight = 2 * initialDistance * Math.tan(fovRad / 2);
    const planeWidth = planeHeight * aspectRatio;
    console.log(`[ImageCalibration] Using FOV: ${useFov}° (provided: ${cameraFov !== undefined})`);

    // Create plane geometry
    const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);
    material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.6,
      side: THREE.DoubleSide,
      depthTest: false,
    });

    plane = new THREE.Mesh(geometry, material);

    // Position plane in front of camera
    updatePlanePosition();

    scene.add(plane);
    active = true;

    console.log("[ImageCalibration] Started");
    console.log(`[ImageCalibration] Initial values: offsetX=${offsetX.toFixed(4)}, offsetY=${offsetY.toFixed(4)}, scale=${scale.toFixed(4)}`);
    console.log("[ImageCalibration] Left stick: move XY, Right stick Y: scale");
    console.log("[ImageCalibration] Trigger to confirm");
  };

  const updatePlanePosition = () => {
    if (!plane) return;

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(captureQuaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(captureQuaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(captureQuaternion);

    // Calculate base position
    const basePosition = capturePosition.clone().add(forward.multiplyScalar(initialDistance));

    // Apply offset (in view space, scaled by distance for consistent feel)
    const offsetWorld = new THREE.Vector3()
      .add(right.clone().multiplyScalar(offsetX * initialDistance))
      .add(up.clone().multiplyScalar(offsetY * initialDistance));

    plane.position.copy(basePosition).add(offsetWorld);
    plane.quaternion.copy(captureQuaternion);

    // Apply scale
    plane.scale.setScalar(scale);
  };

  const update = (frame: XRFrame, deltaSec: number) => {
    if (!active || !plane) return;

    const session = frame.session;
    if (!session) return;

    let dx = 0;
    let dy = 0;
    let dScale = 0;

    // Process controller input
    for (const source of session.inputSources) {
      const gamepad = source.gamepad;
      if (!gamepad) continue;

      const axes = gamepad.axes;
      const buttons = gamepad.buttons;
      if (!axes || axes.length < 4) continue;
      if (!buttons || buttons.length < 4) continue;

      const handedness = source.handedness;

      // Check if thumbstick is being touched
      const thumbstickButton = buttons[3];
      if (!thumbstickButton?.touched) continue;

      const axisX = applyDeadzone(axes[2]!);
      const axisY = applyDeadzone(-axes[3]!);

      if (handedness === "left") {
        // Left stick: XY offset
        dx += axisX * MOVE_SPEED * deltaSec;
        dy += axisY * MOVE_SPEED * deltaSec;
      } else if (handedness === "right") {
        // Right stick Y: scale
        dScale += axisY * SCALE_SPEED * deltaSec;
      }
    }

    // Apply changes
    if (dx !== 0 || dy !== 0 || dScale !== 0) {
      offsetX += dx;
      offsetY += dy;
      scale = Math.max(0.1, scale + dScale);
      updatePlanePosition();
    }
  };

  const confirm = () => {
    if (!active) return;

    const params: ImageCalibrationParams = {
      offsetX,
      offsetY,
      scale,
    };

    console.log("[ImageCalibration] Confirmed:", params);

    // Clean up
    if (plane) {
      scene.remove(plane);
      plane.geometry.dispose();
      if (material) {
        material.map?.dispose();
        material.dispose();
      }
      plane = null;
      material = null;
    }

    active = false;
    onComplete(params);
  };

  const isActive = () => active;

  const dispose = () => {
    if (plane) {
      scene.remove(plane);
      plane.geometry.dispose();
      if (material) {
        material.map?.dispose();
        material.dispose();
      }
      plane = null;
      material = null;
    }
    active = false;
    console.log("[ImageCalibration] Disposed");
  };

  return {
    start,
    update,
    confirm,
    isActive,
    dispose,
  };
};
