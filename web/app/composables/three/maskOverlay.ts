import * as THREE from "three";

export type MaskMesh = {
  mesh: THREE.Mesh;
  anchor: XRAnchor | null;
  maskId: number;
  /** Base64-encoded JPEG of inpainted crop region */
  inpaintData?: string;
  /** Bounding box of inpainted crop [x1, y1, x2, y2] */
  inpaintBbox?: [number, number, number, number];
  /** Original mask bbox in image coordinates [x1, y1, x2, y2] */
  originalBbox?: [number, number, number, number];
};

export type MaskOverlayHandle = {
  /** Add a mask to the scene */
  addMask: (
    maskBase64: string,
    color: [number, number, number],
    position: THREE.Vector3,
    size: THREE.Vector2,
    id: number,
    cameraQuaternion?: THREE.Quaternion,
    inpaintData?: string,
    inpaintBbox?: [number, number, number, number],
    originalBbox?: [number, number, number, number]
  ) => Promise<MaskMesh>;
  /** Create anchors for all masks (call once after adding masks) */
  createAnchors: (frame: XRFrame, referenceSpace: XRReferenceSpace) => Promise<void>;
  /** Update positions from XRAnchors */
  updateAnchors: (frame: XRFrame, referenceSpace: XRReferenceSpace) => void;
  /** Show/hide all masks */
  setVisible: (visible: boolean) => void;
  /** Get mask count */
  getMaskCount: () => number;
  /** Get all masks for hit testing */
  getMasks: () => MaskMesh[];
  /** Hide a specific mask by ID */
  hideMask: (maskId: number) => boolean;
  /** Release resources */
  dispose: () => void;
};

export type MaskOverlayOptions = {
  scene: THREE.Scene;
  /** Mask opacity (default: 0.5) */
  opacity?: number;
};

const maskVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const maskFragmentShader = /* glsl */ `
  uniform sampler2D maskTexture;
  uniform vec3 maskColor;
  uniform float opacity;
  varying vec2 vUv;

  void main() {
    float mask = texture2D(maskTexture, vUv).r;
    if (mask < 0.5) discard;
    gl_FragColor = vec4(maskColor, opacity * mask);
  }
`;

/**
 * Overlay manager for displaying segmentation masks in 3D space
 */
export const createMaskOverlay = (
  options: MaskOverlayOptions
): MaskOverlayHandle => {
  const { scene, opacity = 0.5 } = options;
  const textureLoader = new THREE.TextureLoader();
  const masks: MaskMesh[] = [];

  const addMask = async (
    maskBase64: string,
    color: [number, number, number],
    position: THREE.Vector3,
    size: THREE.Vector2,
    id: number,
    cameraQuaternion?: THREE.Quaternion,
    inpaintData?: string,
    inpaintBbox?: [number, number, number, number],
    originalBbox?: [number, number, number, number]
  ): Promise<MaskMesh> => {
    const dataUrl = `data:image/png;base64,${maskBase64}`;
    const texture = await textureLoader.loadAsync(dataUrl);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        maskTexture: { value: texture },
        maskColor: {
          value: new THREE.Vector3(
            color[0] / 255,
            color[1] / 255,
            color[2] / 255
          ),
        },
        opacity: { value: opacity },
      },
      vertexShader: maskVertexShader,
      fragmentShader: maskFragmentShader,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
    });

    const geometry = new THREE.PlaneGeometry(size.x, size.y);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(position);
    mesh.renderOrder = 100 + id;
    mesh.name = `segmentation-mask-${id}`;

    if (cameraQuaternion) {
      mesh.quaternion.copy(cameraQuaternion);
    }

    scene.add(mesh);

    const maskMesh: MaskMesh = {
      mesh,
      anchor: null,
      maskId: id,
      inpaintData,
      inpaintBbox,
      originalBbox,
    };

    masks.push(maskMesh);
    console.log(`[MaskOverlay] Added mask ${id} at`, position.toArray());

    return maskMesh;
  };

  const createAnchors = async (
    frame: XRFrame,
    referenceSpace: XRReferenceSpace
  ): Promise<void> => {
    // Check if anchor creation is supported
    if (typeof frame.createAnchor !== "function") {
      console.warn("[MaskOverlay] createAnchor not supported on this device");
      return;
    }

    for (const maskMesh of masks) {
      if (maskMesh.anchor) continue; // Already has anchor

      try {
        const { position, quaternion } = maskMesh.mesh;
        const transform = new XRRigidTransform(
          { x: position.x, y: position.y, z: position.z, w: 1 },
          { x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w }
        );

        const anchor = await frame.createAnchor!(transform, referenceSpace);
        if (anchor) {
          maskMesh.anchor = anchor;
          console.log(`[MaskOverlay] Created anchor for mask ${maskMesh.maskId}`);
        }
      } catch (e) {
        console.warn(
          `[MaskOverlay] Failed to create anchor for mask ${maskMesh.maskId}:`,
          e
        );
      }
    }
  };

  const updateAnchors = (frame: XRFrame, referenceSpace: XRReferenceSpace) => {
    for (const maskMesh of masks) {
      if (!maskMesh.anchor) continue;

      try {
        const anchorPose = frame.getPose(
          maskMesh.anchor.anchorSpace,
          referenceSpace
        );

        if (anchorPose) {
          const { position, orientation } = anchorPose.transform;
          maskMesh.mesh.position.set(position.x, position.y, position.z);
          maskMesh.mesh.quaternion.set(
            orientation.x,
            orientation.y,
            orientation.z,
            orientation.w
          );
        }
      } catch {
        // Skip invalid anchors
      }
    }
  };

  const setVisible = (visible: boolean) => {
    masks.forEach((m) => {
      m.mesh.visible = visible;
    });
  };

  const getMaskCount = () => masks.length;

  const getMasks = () => [...masks];

  const hideMask = (maskId: number): boolean => {
    const maskMesh = masks.find((m) => m.maskId === maskId);
    if (maskMesh) {
      maskMesh.mesh.visible = false;
      return true;
    }
    return false;
  };

  const dispose = () => {
    for (const maskMesh of masks) {
      scene.remove(maskMesh.mesh);
      maskMesh.mesh.geometry.dispose();

      const material = maskMesh.mesh.material as THREE.ShaderMaterial;
      if (material.uniforms.maskTexture?.value) {
        (material.uniforms.maskTexture.value as THREE.Texture).dispose();
      }
      material.dispose();

      if (maskMesh.anchor) {
        maskMesh.anchor.delete();
      }
    }
    masks.length = 0;
    console.log("[MaskOverlay] Disposed all masks");
  };

  return {
    addMask,
    createAnchors,
    updateAnchors,
    setVisible,
    getMaskCount,
    getMasks,
    hideMask,
    dispose,
  };
};
