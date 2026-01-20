import * as THREE from "three";

export type HintArrowOptions = {
  /** Distance from camera (default: 0.8) */
  distance?: number;
  /** Idle time before showing hint in seconds (default: 5) */
  idleTime?: number;
  /** Arrow color (default: yellow) */
  color?: number;
};

export type MaskData = {
  mesh: THREE.Mesh;
  maskId: number;
};

/**
 * Creates a hint arrow that points to the nearest mask
 * Shows after player hasn't destroyed any mask for a while
 */
export const createHintArrow = (options: HintArrowOptions = {}) => {
  const {
    distance = 0.8,
    idleTime = 5,
    color = 0xffff00,
  } = options;

  // Arrow geometry (cone pointing down, we'll rotate it)
  const geometry = new THREE.ConeGeometry(0.025, 0.06, 4);
  geometry.rotateX(Math.PI); // Point downward by default

  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });

  const arrow = new THREE.Mesh(geometry, material);
  arrow.renderOrder = 998;
  arrow.visible = false;

  let lastDestroyTime = performance.now();
  let pulseTime = 0;

  /**
   * Find the nearest visible mask from camera position
   */
  const getNearestMask = (
    camera: THREE.Camera,
    masks: MaskData[]
  ): MaskData | null => {
    const visibleMasks = masks.filter((m) => m.mesh.visible);
    if (visibleMasks.length === 0) return null;

    let nearest: MaskData | null = null;
    let minDistance = Infinity;

    for (const mask of visibleMasks) {
      const dist = camera.position.distanceTo(mask.mesh.position);
      if (dist < minDistance) {
        minDistance = dist;
        nearest = mask;
      }
    }

    return nearest;
  };

  /**
   * Called when a mask is destroyed - resets the idle timer
   */
  const onDestroy = () => {
    lastDestroyTime = performance.now();
    arrow.visible = false;
  };

  /**
   * Reset the arrow state (called on game restart)
   */
  const reset = () => {
    lastDestroyTime = performance.now();
    arrow.visible = false;
    pulseTime = 0;
  };

  /**
   * Update arrow position and visibility
   */
  const update = (
    camera: THREE.Camera,
    masks: MaskData[],
    deltaTime: number
  ) => {
    const elapsed = (performance.now() - lastDestroyTime) / 1000;

    // Don't show if not enough idle time
    if (elapsed < idleTime) {
      arrow.visible = false;
      return;
    }

    const nearest = getNearestMask(camera, masks);
    if (!nearest) {
      arrow.visible = false;
      return;
    }

    arrow.visible = true;
    pulseTime += deltaTime;

    // Position arrow in front of camera
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      camera.quaternion
    );
    arrow.position.copy(camera.position).add(forward.multiplyScalar(distance));

    // Point arrow toward nearest mask
    const toMask = nearest.mesh.position
      .clone()
      .sub(arrow.position)
      .normalize();

    // Create rotation from default direction (0, -1, 0) to target direction
    const defaultDir = new THREE.Vector3(0, -1, 0);
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      defaultDir,
      toMask
    );
    arrow.quaternion.copy(quaternion);

    // Pulse effect (scale and opacity)
    const pulse = 0.8 + 0.2 * Math.sin(pulseTime * 4);
    arrow.scale.setScalar(pulse);
    material.opacity = 0.6 + 0.3 * pulse;
  };

  const dispose = () => {
    geometry.dispose();
    material.dispose();
  };

  return {
    arrow,
    update,
    onDestroy,
    reset,
    dispose,
  };
};
