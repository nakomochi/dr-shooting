import * as THREE from "three";

export type DestructionPlaneOptions = {
  /** Scale multiplier (default: 1.0) */
  scaleMultiplier?: number;
  /** Combined inpaint data getter (for combined mode) */
  getCombinedInpaintData?: () => string | null;
  /** Image size getter [width, height] */
  getImageSize?: () => [number, number] | null;
};

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Fragment shader for white fallback (no inpaint texture)
const whiteFragmentShader = /* glsl */ `
  uniform sampler2D maskTexture;
  varying vec2 vUv;

  void main() {
    float mask = texture2D(maskTexture, vUv).r;
    if (mask < 0.5) discard;
    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
  }
`;

// Fragment shader for inpaint texture (individual crop mode)
const inpaintFragmentShader = /* glsl */ `
  uniform sampler2D maskTexture;
  uniform sampler2D inpaintTexture;
  varying vec2 vUv;

  void main() {
    float mask = texture2D(maskTexture, vUv).r;
    if (mask < 0.5) discard;
    vec3 color = texture2D(inpaintTexture, vUv).rgb;
    gl_FragColor = vec4(color, 1.0);
  }
`;

// Fragment shader for combined inpaint texture (maps UV to bbox region)
const combinedInpaintFragmentShader = /* glsl */ `
  uniform sampler2D maskTexture;
  uniform sampler2D inpaintTexture;
  uniform vec4 bboxUV;  // [u1, v1, u2, v2] normalized coords
  varying vec2 vUv;

  void main() {
    float mask = texture2D(maskTexture, vUv).r;
    if (mask < 0.5) discard;
    // Map local UV to bbox region in full image
    vec2 inpaintUv = mix(bboxUV.xy, bboxUV.zw, vUv);
    vec3 color = texture2D(inpaintTexture, inpaintUv).rgb;
    gl_FragColor = vec4(color, 1.0);
  }
`;

/**
 * Manages planes that appear when masks are destroyed
 * Uses inpaint texture if available, otherwise falls back to white
 */
export const createDestructionPlaneManager = (
  scene: THREE.Scene,
  options: DestructionPlaneOptions = {}
) => {
  const { scaleMultiplier = 1.0, getCombinedInpaintData, getImageSize } = options;
  const textureLoader = new THREE.TextureLoader();
  let combinedInpaintTexture: THREE.Texture | null = null;

  type PlaneData = {
    mesh: THREE.Mesh;
    material: THREE.ShaderMaterial;
  };

  const planes: PlaneData[] = [];

  /**
   * Load combined inpaint texture (lazy loading)
   */
  const loadCombinedInpaintTexture = async (): Promise<THREE.Texture | null> => {
    if (combinedInpaintTexture) return combinedInpaintTexture;

    const data = getCombinedInpaintData?.();
    if (!data) return null;

    try {
      const dataUrl = `data:image/jpeg;base64,${data}`;
      combinedInpaintTexture = await textureLoader.loadAsync(dataUrl);
      combinedInpaintTexture.minFilter = THREE.LinearFilter;
      combinedInpaintTexture.magFilter = THREE.LinearFilter;
      combinedInpaintTexture.wrapS = THREE.ClampToEdgeWrapping;
      combinedInpaintTexture.wrapT = THREE.ClampToEdgeWrapping;
      console.log("[DestructionPlane] Combined inpaint texture loaded");
      return combinedInpaintTexture;
    } catch (e) {
      console.warn("[DestructionPlane] Failed to load combined inpaint texture", e);
      return null;
    }
  };

  /**
   * Spawn plane at destroyed mask position with inpaint or white texture
   */
  const spawn = async (
    maskMesh: THREE.Mesh,
    inpaintData?: string,
    _inpaintBbox?: [number, number, number, number],
    originalBbox?: [number, number, number, number]
  ) => {
    // Get the original mask's shader material to access its texture
    const originalMaterial = maskMesh.material as THREE.ShaderMaterial;
    const maskTexture = originalMaterial.uniforms.maskTexture?.value as THREE.Texture;

    if (!maskTexture) {
      console.warn("[DestructionPlane] No mask texture found");
      return;
    }

    // Clone the mask texture
    const clonedMaskTexture = maskTexture.clone();
    clonedMaskTexture.needsUpdate = true;

    let material: THREE.ShaderMaterial;

    // Priority: combined inpaint > individual inpaint > white fallback
    const combinedTexture = await loadCombinedInpaintTexture();
    const imageSize = getImageSize?.();

    if (combinedTexture && originalBbox && imageSize) {
      // Use combined inpaint with bbox UV mapping
      const [imgWidth, imgHeight] = imageSize;
      const [x1, y1, x2, y2] = originalBbox;

      // Convert bbox to normalized UV coordinates
      // Note: Y is flipped in UV space (0 at bottom, 1 at top)
      const bboxUV = new THREE.Vector4(
        x1 / imgWidth,
        1 - y2 / imgHeight,  // flip Y
        x2 / imgWidth,
        1 - y1 / imgHeight   // flip Y
      );

      material = new THREE.ShaderMaterial({
        uniforms: {
          maskTexture: { value: clonedMaskTexture },
          inpaintTexture: { value: combinedTexture },
          bboxUV: { value: bboxUV },
        },
        vertexShader,
        fragmentShader: combinedInpaintFragmentShader,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: false,
      });

      console.log("[DestructionPlane] Using combined inpaint texture with bbox UV mapping");
    } else if (inpaintData) {
      try {
        // Load individual inpaint texture
        const dataUrl = `data:image/jpeg;base64,${inpaintData}`;
        const inpaintTexture = await textureLoader.loadAsync(dataUrl);
        inpaintTexture.minFilter = THREE.LinearFilter;
        inpaintTexture.magFilter = THREE.LinearFilter;
        inpaintTexture.wrapS = THREE.ClampToEdgeWrapping;
        inpaintTexture.wrapT = THREE.ClampToEdgeWrapping;

        material = new THREE.ShaderMaterial({
          uniforms: {
            maskTexture: { value: clonedMaskTexture },
            inpaintTexture: { value: inpaintTexture },
          },
          vertexShader,
          fragmentShader: inpaintFragmentShader,
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
          depthTest: false,
        });

        console.log("[DestructionPlane] Using individual inpaint texture");
      } catch (e) {
        console.warn("[DestructionPlane] Failed to load inpaint texture, using white fallback", e);
        material = new THREE.ShaderMaterial({
          uniforms: {
            maskTexture: { value: clonedMaskTexture },
          },
          vertexShader,
          fragmentShader: whiteFragmentShader,
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
          depthTest: false,
        });
      }
    } else {
      // White fallback
      material = new THREE.ShaderMaterial({
        uniforms: {
          maskTexture: { value: clonedMaskTexture },
        },
        vertexShader,
        fragmentShader: whiteFragmentShader,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: false,
      });
    }

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
      // Only dispose individual inpaint textures (not combined, as it's shared)
      const inpaintTex = plane.material.uniforms.inpaintTexture?.value as THREE.Texture | undefined;
      if (inpaintTex && inpaintTex !== combinedInpaintTexture) {
        inpaintTex.dispose();
      }
      plane.material.dispose();
    }
    planes.length = 0;

    // Dispose combined texture
    if (combinedInpaintTexture) {
      combinedInpaintTexture.dispose();
      combinedInpaintTexture = null;
    }
  };

  return { spawn, dispose };
};
