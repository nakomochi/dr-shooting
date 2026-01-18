import * as THREE from "three";

export type HitResult = {
  maskId: number;
  position: THREE.Vector3;
  mask: THREE.Mesh;
};

export type ShotEffectOptions = {
  /** Duration in milliseconds (default: 300) */
  duration?: number;
  /** Bullet size (default: 0.03) */
  bulletSize?: number;
  /** Bullet color (default: yellow) */
  color?: number;
  /** Callback when bullet hits a mask */
  onHit?: (result: HitResult) => void;
  /** Function to get current mask meshes for collision detection */
  getMasks?: () => Array<{ mesh: THREE.Mesh; maskId: number }>;
};

/**
 * Manages 3D shot effects (bullets flying from gun to reticle)
 */
export const createShotEffectManager = (scene: THREE.Scene, options: ShotEffectOptions = {}) => {
  const {
    duration = 300,
    bulletSize = 0.03,
    color = 0xffff00,
    onHit,
    getMasks,
  } = options;

  const geometry = new THREE.SphereGeometry(1, 16, 16);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 1,
    depthTest: false,
  });

  type BulletData = {
    mesh: THREE.Mesh;
    startTime: number;
    startPosition: THREE.Vector3;
    targetPosition: THREE.Vector3;
    prevPosition: THREE.Vector3;
  };

  const activeBullets: BulletData[] = [];
  const raycaster = new THREE.Raycaster();

  /**
   * Check collision using raycast from previous position to current position
   */
  const checkCollision = (
    prevPos: THREE.Vector3,
    currentPos: THREE.Vector3
  ): HitResult | null => {
    if (!getMasks) return null;

    const masks = getMasks();
    if (masks.length === 0) return null;

    // Get visible mask meshes
    const visibleMeshes = masks
      .filter(({ mesh }) => mesh.visible)
      .map(({ mesh }) => mesh);

    if (visibleMeshes.length === 0) return null;

    // Raycast from previous position toward current position
    const direction = new THREE.Vector3().subVectors(currentPos, prevPos);
    const distance = direction.length();
    if (distance === 0) return null;

    direction.normalize();
    raycaster.set(prevPos, direction);
    raycaster.far = distance + bulletSize * 2;

    const intersects = raycaster.intersectObjects(visibleMeshes, false);

    if (intersects.length > 0) {
      const hit = intersects[0]!;
      const hitMesh = hit.object as THREE.Mesh;
      const maskData = masks.find(({ mesh }) => mesh === hitMesh);
      if (maskData) {
        return {
          maskId: maskData.maskId,
          position: hit.point.clone(),
          mask: hitMesh,
        };
      }
    }

    return null;
  };

  /**
   * Fire a bullet
   * @param gunTipPosition World position of gun tip
   * @param targetPosition World position of reticle
   */
  const fire = (gunTipPosition: THREE.Vector3, targetPosition: THREE.Vector3) => {
    const mesh = new THREE.Mesh(geometry, material.clone());
    mesh.position.copy(gunTipPosition);
    mesh.scale.setScalar(bulletSize);
    mesh.renderOrder = 998;

    scene.add(mesh);
    activeBullets.push({
      mesh,
      startTime: performance.now(),
      startPosition: gunTipPosition.clone(),
      targetPosition: targetPosition.clone(),
      prevPosition: gunTipPosition.clone(),
    });
  };

  /**
   * Update bullets each frame
   */
  const update = () => {
    const now = performance.now();

    for (let i = activeBullets.length - 1; i >= 0; i--) {
      const bullet = activeBullets[i];
      if (!bullet) continue;

      const elapsed = now - bullet.startTime;
      const progress = Math.min(elapsed / duration, 1);

      if (progress >= 1) {
        scene.remove(bullet.mesh);
        (bullet.mesh.material as THREE.Material).dispose();
        activeBullets.splice(i, 1);
        continue;
      }

      // Easing (fast start, slow end)
      const eased = 1 - Math.pow(1 - progress, 2);

      // Store previous position before moving
      const prevPos = bullet.mesh.position.clone();

      // Interpolate position
      bullet.mesh.position.lerpVectors(
        bullet.startPosition,
        bullet.targetPosition,
        eased
      );

      // Check for collision using raycast from previous to current position
      if (onHit) {
        const hit = checkCollision(prevPos, bullet.mesh.position);
        if (hit) {
          onHit(hit);
          scene.remove(bullet.mesh);
          (bullet.mesh.material as THREE.Material).dispose();
          activeBullets.splice(i, 1);
          continue;
        }
      }

      // Update previous position for next frame
      bullet.prevPosition.copy(bullet.mesh.position);

      // Fade out in the last 30%
      if (progress > 0.7) {
        const fadeProgress = (progress - 0.7) / 0.3;
        (bullet.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - fadeProgress;
      }
    }
  };

  const dispose = () => {
    for (const bullet of activeBullets) {
      scene.remove(bullet.mesh);
      (bullet.mesh.material as THREE.Material).dispose();
    }
    activeBullets.length = 0;
    geometry.dispose();
    material.dispose();
  };

  return { fire, update, dispose };
};
