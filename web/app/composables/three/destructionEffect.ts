import * as THREE from "three";

export type DestructionEffectOptions = {
  /** Number of particles (default: 30) */
  particleCount?: number;
  /** Particle spread speed (default: 0.3) */
  spreadSpeed?: number;
  /** Effect duration in ms (default: 500) */
  duration?: number;
  /** Particle size (default: 0.02) */
  particleSize?: number;
  /** Gravity strength (default: 2) */
  gravity?: number;
};

type Particle = {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  startTime: number;
};

/**
 * Manages destruction particle effects
 */
export const createDestructionEffectManager = (
  scene: THREE.Scene,
  options: DestructionEffectOptions = {}
) => {
  const {
    particleCount = 30,
    spreadSpeed = 0.3,
    duration = 500,
    particleSize = 0.02,
    gravity = 2,
  } = options;

  const geometry = new THREE.SphereGeometry(1, 8, 8);
  const activeParticles: Particle[] = [];
  let lastUpdateTime = performance.now();

  /**
   * Spawn destruction effect at position
   * @param position World position of the hit
   * @param color Color of particles (default: orange)
   */
  const spawn = (position: THREE.Vector3, color: number = 0xff6600) => {
    const now = performance.now();

    for (let i = 0; i < particleCount; i++) {
      const material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 1,
        depthTest: false,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(position);
      mesh.scale.setScalar(particleSize * (0.5 + Math.random() * 0.5));
      mesh.renderOrder = 1000;

      // Random velocity in sphere, biased upward
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = spreadSpeed * (0.5 + Math.random() * 0.5);

      const velocity = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta) * speed,
        Math.sin(phi) * Math.sin(theta) * speed * 0.5 + speed * 0.3,
        Math.cos(phi) * speed
      );

      scene.add(mesh);
      activeParticles.push({ mesh, velocity, startTime: now });
    }
  };

  /**
   * Update particles each frame
   */
  const update = () => {
    const now = performance.now();
    const deltaTime = Math.min((now - lastUpdateTime) / 1000, 0.1);
    lastUpdateTime = now;

    for (let i = activeParticles.length - 1; i >= 0; i--) {
      const particle = activeParticles[i];
      if (!particle) continue;

      const elapsed = now - particle.startTime;
      const progress = elapsed / duration;

      if (progress >= 1) {
        scene.remove(particle.mesh);
        (particle.mesh.material as THREE.Material).dispose();
        activeParticles.splice(i, 1);
        continue;
      }

      // Apply gravity
      particle.velocity.y -= gravity * deltaTime;

      // Move particle
      particle.mesh.position.add(
        particle.velocity.clone().multiplyScalar(deltaTime)
      );

      // Fade out in the last 50%
      const fadeStart = 0.5;
      if (progress > fadeStart) {
        const fadeProgress = (progress - fadeStart) / (1 - fadeStart);
        (particle.mesh.material as THREE.MeshBasicMaterial).opacity =
          1 - fadeProgress;
      }

      // Shrink slightly
      const scale = particleSize * (1 - progress * 0.5);
      particle.mesh.scale.setScalar(scale);
    }
  };

  const dispose = () => {
    for (const particle of activeParticles) {
      scene.remove(particle.mesh);
      (particle.mesh.material as THREE.Material).dispose();
    }
    activeParticles.length = 0;
    geometry.dispose();
  };

  return { spawn, update, dispose };
};
