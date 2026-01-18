import * as THREE from "three";

export type ShotEffectOptions = {
  /** Duration in milliseconds (default: 300) */
  duration?: number;
  /** Bullet size (default: 0.03) */
  bulletSize?: number;
  /** Bullet color (default: yellow) */
  color?: number;
};

/**
 * Manages 3D shot effects (bullets flying from gun to reticle)
 */
export const createShotEffectManager = (scene: THREE.Scene, options: ShotEffectOptions = {}) => {
  const {
    duration = 300,
    bulletSize = 0.03,
    color = 0xffff00,
  } = options;

  const geometry = new THREE.SphereGeometry(1, 16, 16);
  const material = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 1,
    depthTest: false,
  });

  const activeBullets: Array<{
    mesh: THREE.Mesh;
    startTime: number;
    startPosition: THREE.Vector3;
    targetPosition: THREE.Vector3;
  }> = [];

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

      // Interpolate position
      bullet.mesh.position.lerpVectors(
        bullet.startPosition,
        bullet.targetPosition,
        eased
      );

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
