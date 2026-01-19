import * as THREE from "three";
import type { MaskOverlayHandle, MaskMesh } from "./maskOverlay";

export type CalibrationParams = {
  offsetX: number;
  offsetY: number;
  scaleFactor: number;
  fovAdjust: number;
};

export type CalibrationSample = {
  /** Original image coordinate (normalized -0.5 to 0.5) */
  imageCoord: { u: number; v: number };
  /** Original 3D position before calibration */
  originalPosition: THREE.Vector3;
  /** Confirmed 3D position after user adjustment */
  confirmedPosition: THREE.Vector3;
  /** Camera position at capture time */
  cameraPosition: THREE.Vector3;
  /** Camera quaternion at capture time */
  cameraQuaternion: THREE.Quaternion;
  /** Distance from camera */
  distance: number;
};

export type CalibrationModeOptions = {
  maskOverlay: MaskOverlayHandle;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  imageSize: [number, number];
  cameraFov: number;
  onComplete: (params: CalibrationParams, samples: CalibrationSample[]) => void;
  maxCalibrationCount?: number;
  moveSpeed?: number;
  depthSpeed?: number;
};

export type CalibrationModeHandle = {
  start: () => void;
  update: (frame: XRFrame, deltaSec: number) => void;
  confirmCurrent: () => void;
  isActive: () => boolean;
  getCurrentMaskIndex: () => number;
  getTotalMasks: () => number;
  dispose: () => void;
};

/**
 * Calibration mode for manually adjusting mask positions
 * to determine correct image-to-3D transformation parameters
 */
export const createCalibrationMode = (
  options: CalibrationModeOptions
): CalibrationModeHandle => {
  const {
    maskOverlay,
    camera,
    renderer,
    imageSize,
    cameraFov,
    onComplete,
    maxCalibrationCount = 5,
    moveSpeed = 0.5,
    depthSpeed = 0.3,
  } = options;

  let active = false;
  let currentIndex = 0;
  const samples: CalibrationSample[] = [];
  const masks: MaskMesh[] = [];
  const originalPositions = new Map<number, THREE.Vector3>();
  const originalOpacities = new Map<number, number>();

  // Deadzone for stick input
  const DEADZONE = 0.15;

  const applyDeadzone = (value: number): number => {
    if (Math.abs(value) < DEADZONE) return 0;
    return (value - Math.sign(value) * DEADZONE) / (1 - DEADZONE);
  };

  const start = () => {
    if (active) return;

    const allMasks = maskOverlay.getMasks();
    if (allMasks.length === 0) {
      console.warn("[CalibrationMode] No masks available for calibration");
      return;
    }

    // Select masks for calibration (up to maxCalibrationCount)
    masks.length = 0;
    const count = Math.min(allMasks.length, maxCalibrationCount);
    for (let i = 0; i < count; i++) {
      masks.push(allMasks[i]!);
    }

    // Store original positions and opacities
    for (const mask of masks) {
      originalPositions.set(mask.maskId, mask.mesh.position.clone());
      const material = mask.mesh.material as THREE.ShaderMaterial;
      originalOpacities.set(mask.maskId, material.uniforms.opacity?.value ?? 0.4);
    }

    // Dim all masks except the first one
    for (const mask of allMasks) {
      const material = mask.mesh.material as THREE.ShaderMaterial;
      if (material.uniforms.opacity) {
        if (masks.includes(mask)) {
          material.uniforms.opacity.value = mask === masks[0] ? 0.8 : 0.2;
        } else {
          material.uniforms.opacity.value = 0.1;
        }
      }
    }

    active = true;
    currentIndex = 0;
    samples.length = 0;

    console.log(`[CalibrationMode] Started with ${masks.length} masks`);
    console.log(`[CalibrationMode] Adjust mask ${currentIndex + 1}/${masks.length} using controller sticks`);
  };

  const highlightMask = (index: number) => {
    const allMasks = maskOverlay.getMasks();
    for (const mask of allMasks) {
      const material = mask.mesh.material as THREE.ShaderMaterial;
      if (material.uniforms.opacity) {
        if (mask === masks[index]) {
          material.uniforms.opacity.value = 0.8;
        } else if (masks.includes(mask)) {
          material.uniforms.opacity.value = 0.2;
        } else {
          material.uniforms.opacity.value = 0.1;
        }
      }
    }
  };

  const update = (frame: XRFrame, deltaSec: number) => {
    if (!active || currentIndex >= masks.length) return;

    const session = frame.session;
    if (!session) return;

    const currentMask = masks[currentIndex]!;
    const xrCamera = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;

    // Get camera vectors for movement
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(xrCamera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(xrCamera.quaternion);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(xrCamera.quaternion);

    // Accumulate input from controllers
    let dx = 0;
    let dy = 0;
    let dz = 0;

    // Process controller input
    // xr-standard mapping:
    // - axes[2], axes[3]: thumbstick X/Y values
    // - buttons[3]: thumbstick button (buttons[3].touched = true when touching stick)
    // Left controller: XY movement, Right controller: depth (Z) movement
    for (const source of session.inputSources) {
      const gamepad = source.gamepad;
      if (!gamepad) continue;

      const axes = gamepad.axes;
      const buttons = gamepad.buttons;
      if (!axes || axes.length < 4) continue;
      if (!buttons || buttons.length < 4) continue;

      const handedness = source.handedness;

      // Check if thumbstick is being touched (buttons[3].touched)
      const thumbstickButton = buttons[3];
      if (!thumbstickButton?.touched) continue; // Skip if not touching the thumbstick

      // Thumbstick position is at axes[2] (X) and axes[3] (Y)
      const axisX = applyDeadzone(axes[2]!);
      const axisY = applyDeadzone(-axes[3]!); // Invert Y for natural movement

      if (handedness === "left") {
        // Left stick: XY movement
        dx += axisX * moveSpeed * deltaSec;
        dy += axisY * moveSpeed * deltaSec;
      } else if (handedness === "right") {
        // Right stick Y: depth movement (forward/backward)
        dz += axisY * depthSpeed * deltaSec;
      }
    }

    // Apply movement
    if (dx !== 0) {
      currentMask.mesh.position.add(right.clone().multiplyScalar(dx));
    }
    if (dy !== 0) {
      currentMask.mesh.position.add(up.clone().multiplyScalar(dy));
    }
    if (dz !== 0) {
      currentMask.mesh.position.add(forward.clone().multiplyScalar(dz));
    }
  };

  const confirmCurrent = () => {
    if (!active || currentIndex >= masks.length) return;

    const currentMask = masks[currentIndex]!;
    const xrCamera = renderer.xr.isPresenting ? renderer.xr.getCamera() : camera;
    const [imgWidth, imgHeight] = imageSize;

    // Get original bbox center as normalized image coordinate
    const bbox = currentMask.originalBbox;
    let imageCoord = { u: 0, v: 0 };
    if (bbox) {
      imageCoord = {
        u: (bbox[0] + bbox[2]) / 2 / imgWidth - 0.5,
        v: -((bbox[1] + bbox[3]) / 2 / imgHeight - 0.5),
      };
    }

    // Record calibration sample
    const sample: CalibrationSample = {
      imageCoord,
      originalPosition: originalPositions.get(currentMask.maskId)!.clone(),
      confirmedPosition: currentMask.mesh.position.clone(),
      cameraPosition: xrCamera.position.clone(),
      cameraQuaternion: xrCamera.quaternion.clone(),
      distance: currentMask.mesh.position.distanceTo(xrCamera.position),
    };

    samples.push(sample);

    console.log(`[CalibrationMode] Confirmed mask ${currentIndex + 1}/${masks.length}`);
    console.log(`  Image coord: (${imageCoord.u.toFixed(3)}, ${imageCoord.v.toFixed(3)})`);
    console.log(`  Original: ${sample.originalPosition.toArray().map(v => v.toFixed(3)).join(", ")}`);
    console.log(`  Confirmed: ${sample.confirmedPosition.toArray().map(v => v.toFixed(3)).join(", ")}`);
    console.log(`  Distance: ${sample.distance.toFixed(3)}m`);

    currentIndex++;

    if (currentIndex >= masks.length) {
      // Calibration complete
      finishCalibration();
    } else {
      // Move to next mask
      highlightMask(currentIndex);
      console.log(`[CalibrationMode] Adjust mask ${currentIndex + 1}/${masks.length}`);
    }
  };

  const finishCalibration = () => {
    console.log("[CalibrationMode] Calibration complete, calculating parameters...");

    // Calculate transformation parameters from samples
    const params = calculateParameters(samples, cameraFov, imageSize);

    console.log("[CalibrationMode] Calculated parameters:", params);

    // Restore original opacities
    const allMasks = maskOverlay.getMasks();
    for (const mask of allMasks) {
      const material = mask.mesh.material as THREE.ShaderMaterial;
      if (material.uniforms.opacity) {
        const originalOpacity = originalOpacities.get(mask.maskId) ?? 0.4;
        material.uniforms.opacity.value = originalOpacity;
      }
    }

    active = false;
    onComplete(params, samples);
  };

  const isActive = () => active;
  const getCurrentMaskIndex = () => currentIndex;
  const getTotalMasks = () => masks.length;

  const dispose = () => {
    active = false;
    masks.length = 0;
    samples.length = 0;
    originalPositions.clear();
    originalOpacities.clear();
    console.log("[CalibrationMode] Disposed");
  };

  return {
    start,
    update,
    confirmCurrent,
    isActive,
    getCurrentMaskIndex,
    getTotalMasks,
    dispose,
  };
};

/**
 * Calculate calibration parameters from collected samples
 * Uses least squares to find optimal offset and scale
 */
function calculateParameters(
  samples: CalibrationSample[],
  cameraFov: number,
  imageSize: [number, number]
): CalibrationParams {
  if (samples.length === 0) {
    return { offsetX: 0, offsetY: 0, scaleFactor: 1, fovAdjust: 0 };
  }

  const [imgWidth, imgHeight] = imageSize;
  const aspectRatio = imgWidth / imgHeight;
  const fovRad = THREE.MathUtils.degToRad(cameraFov);

  // Calculate offsets and scale adjustments for each sample
  const offsetXSamples: number[] = [];
  const offsetYSamples: number[] = [];
  const scaleFactorSamples: number[] = [];

  for (const sample of samples) {
    const { imageCoord, originalPosition, confirmedPosition, cameraPosition, cameraQuaternion, distance } = sample;

    // Get camera vectors
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraQuaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cameraQuaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cameraQuaternion);

    // Calculate view dimensions at the confirmed distance
    const viewHeight = 2 * distance * Math.tan(fovRad / 2);
    const viewWidth = viewHeight * aspectRatio;

    // Calculate expected position based on image coord (with current offset=0, scale=1)
    const expectedPosition = cameraPosition.clone()
      .add(forward.clone().multiplyScalar(distance))
      .add(right.clone().multiplyScalar(imageCoord.u * viewWidth))
      .add(up.clone().multiplyScalar(imageCoord.v * viewHeight));

    // Calculate the offset needed to move from expected to confirmed
    const delta = confirmedPosition.clone().sub(expectedPosition);

    // Project delta onto camera right and up vectors to get offset in normalized coordinates
    const deltaX = delta.dot(right) / viewWidth;
    const deltaY = delta.dot(up) / viewHeight;

    offsetXSamples.push(deltaX);
    offsetYSamples.push(deltaY);

    // Calculate scale factor based on distance ratio
    const originalDistance = originalPosition.distanceTo(cameraPosition);
    if (originalDistance > 0) {
      scaleFactorSamples.push(distance / originalDistance);
    }
  }

  // Average the samples
  const avgOffsetX = offsetXSamples.reduce((a, b) => a + b, 0) / offsetXSamples.length;
  const avgOffsetY = offsetYSamples.reduce((a, b) => a + b, 0) / offsetYSamples.length;
  const avgScaleFactor = scaleFactorSamples.length > 0
    ? scaleFactorSamples.reduce((a, b) => a + b, 0) / scaleFactorSamples.length
    : 1;

  // Log individual samples for debugging
  console.log("[CalibrationMode] Individual samples:");
  for (let i = 0; i < samples.length; i++) {
    console.log(`  Sample ${i + 1}: offsetX=${offsetXSamples[i]?.toFixed(4)}, offsetY=${offsetYSamples[i]?.toFixed(4)}, scale=${scaleFactorSamples[i]?.toFixed(4)}`);
  }

  return {
    offsetX: avgOffsetX,
    offsetY: avgOffsetY,
    scaleFactor: avgScaleFactor,
    fovAdjust: 0, // TODO: implement FOV adjustment calculation if needed
  };
}

/**
 * Save calibration parameters to localStorage
 */
export function saveCalibrationParams(params: CalibrationParams): void {
  try {
    localStorage.setItem("calibrationParams", JSON.stringify(params));
    console.log("[CalibrationMode] Saved parameters to localStorage");
  } catch (e) {
    console.warn("[CalibrationMode] Failed to save parameters:", e);
  }
}

/**
 * Load calibration parameters from localStorage
 */
export function loadCalibrationParams(): CalibrationParams | null {
  try {
    const stored = localStorage.getItem("calibrationParams");
    if (stored) {
      const params = JSON.parse(stored) as CalibrationParams;
      console.log("[CalibrationMode] Loaded parameters from localStorage:", params);
      return params;
    }
  } catch (e) {
    console.warn("[CalibrationMode] Failed to load parameters:", e);
  }
  return null;
}
