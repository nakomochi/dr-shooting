import * as THREE from "three";

export type DestructionEffectOptions = {
  /** Number of particles for point spawn (default: 30) */
  particleCount?: number;
  /** Number of particles for mask spawn (default: 100) */
  maskParticleCount?: number;
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
    maskParticleCount = 100,
    spreadSpeed = 0.3,
    duration = 500,
    particleSize = 0.02,
    gravity = 2,
  } = options;

  const geometry = new THREE.SphereGeometry(1, 8, 8);
  const activeParticles: Particle[] = [];
  let lastUpdateTime = performance.now();

  /**
   * Create a single particle at position with velocity
   */
  const createParticle = (
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    color: number,
    size: number,
    now: number
  ) => {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 1,
      depthTest: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.scale.setScalar(size);
    mesh.renderOrder = 1000;

    scene.add(mesh);
    activeParticles.push({ mesh, velocity, startTime: now });
  };

  /**
   * Spawn destruction effect at a single point
   * @param position World position of the hit
   * @param color Color of particles (default: orange)
   */
  const spawn = (position: THREE.Vector3, color: number = 0xff6600) => {
    const now = performance.now();

    for (let i = 0; i < particleCount; i++) {
      // Random velocity in sphere, biased upward
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const speed = spreadSpeed * (0.5 + Math.random() * 0.5);

      const velocity = new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta) * speed,
        Math.sin(phi) * Math.sin(theta) * speed * 0.5 + speed * 0.3,
        Math.cos(phi) * speed
      );

      const size = particleSize * (0.5 + Math.random() * 0.5);
      createParticle(position.clone(), velocity, color, size, now);
    }
  };

  /**
   * Spawn destruction effect from entire mask surface
   * Particles explode outward from all parts of the mask
   * @param maskMesh The mask mesh to explode
   * @param hitPosition The position where the bullet hit (for directional bias)
   * @param color Color of particles (default: orange)
   */
  const spawnFromMask = (
    maskMesh: THREE.Mesh,
    hitPosition: THREE.Vector3,
    color: number = 0xff6600
  ) => {
    const now = performance.now();

    // Get mask's world transform
    maskMesh.updateMatrixWorld(true);
    const worldMatrix = maskMesh.matrixWorld;

    // Get mask geometry bounds
    const geo = maskMesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bbox = geo.boundingBox!;

    // Get mask normal (facing direction)
    const maskNormal = new THREE.Vector3(0, 0, 1).applyQuaternion(maskMesh.quaternion).normalize();

    // Calculate mask center in world space
    const maskCenter = new THREE.Vector3();
    bbox.getCenter(maskCenter);
    maskCenter.applyMatrix4(worldMatrix);

    // Direction from hit point (for explosion bias)
    const hitDir = maskCenter.clone().sub(hitPosition).normalize();

    for (let i = 0; i < maskParticleCount; i++) {
      // Random position within mask bounds (local space)
      const localPos = new THREE.Vector3(
        bbox.min.x + Math.random() * (bbox.max.x - bbox.min.x),
        bbox.min.y + Math.random() * (bbox.max.y - bbox.min.y),
        0 // Flat on mask surface
      );

      // Transform to world space
      const worldPos = localPos.applyMatrix4(worldMatrix);

      // Base velocity: outward from mask normal + random spread
      const baseSpeed = spreadSpeed * (0.8 + Math.random() * 0.6);

      // Combine mask normal direction with some randomness and hit direction
      const randomDir = new THREE.Vector3(
        (Math.random() - 0.5) * 0.8,
        (Math.random() - 0.5) * 0.8 + 0.2, // Slight upward bias
        (Math.random() - 0.5) * 0.8
      );

      const velocity = new THREE.Vector3()
        .addScaledVector(maskNormal, baseSpeed * 0.6)
        .addScaledVector(randomDir, baseSpeed * 0.4)
        .addScaledVector(hitDir, baseSpeed * 0.2);

      // Vary particle size
      const size = particleSize * (0.3 + Math.random() * 0.7);

      createParticle(worldPos, velocity, color, size, now);
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

  return { spawn, spawnFromMask, update, dispose };
};
