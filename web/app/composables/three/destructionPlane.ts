import * as THREE from "three";

export type DestructionPlaneOptions = {
  /** Scale multiplier (default: 1.0) */
  scaleMultiplier?: number;
};

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D maskTexture;
  varying vec2 vUv;

  void main() {
    float mask = texture2D(maskTexture, vUv).r;
    if (mask < 0.5) discard;
    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
  }
`;

/**
 * Manages white planes that appear when masks are destroyed
 * Uses mask texture to match the exact shape of the segmentation
 */
export const createDestructionPlaneManager = (
  scene: THREE.Scene,
  options: DestructionPlaneOptions = {}
) => {
  const { scaleMultiplier = 1.0 } = options;

  type PlaneData = {
    mesh: THREE.Mesh;
    material: THREE.ShaderMaterial;
  };

  const planes: PlaneData[] = [];

  /**
   * Spawn white plane at destroyed mask position with same shape
   */
  const spawn = (
    maskMesh: THREE.Mesh
  ) => {
    // Get the original mask's shader material to access its texture
    const originalMaterial = maskMesh.material as THREE.ShaderMaterial;
    const maskTexture = originalMaterial.uniforms.maskTexture?.value as THREE.Texture;

    if (!maskTexture) {
      console.warn("[DestructionPlane] No mask texture found");
      return;
    }

    // Clone the texture for our use
    const clonedTexture = maskTexture.clone();
    clonedTexture.needsUpdate = true;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        maskTexture: { value: clonedTexture },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });

    // Clone the geometry
    const geometry = maskMesh.geometry.clone();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(maskMesh.position);
    mesh.quaternion.copy(maskMesh.quaternion);
    mesh.scale.copy(maskMesh.scale).multiplyScalar(scaleMultiplier);
    mesh.renderOrder = 200; // Above masks (100) but below UI

    scene.add(mesh);
    planes.push({ mesh, material });
  };

  const dispose = () => {
    for (const plane of planes) {
      scene.remove(plane.mesh);
      plane.mesh.geometry.dispose();
      if (plane.material.uniforms.maskTexture?.value) {
        (plane.material.uniforms.maskTexture.value as THREE.Texture).dispose();
      }
      plane.material.dispose();
    }
    planes.length = 0;
  };

  return { spawn, dispose };
};
