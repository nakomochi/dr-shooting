import * as THREE from "three";

export type RoomMeshHandle = {
  /** Start mesh detection (call after XR session starts) */
  start: (session: XRSession) => Promise<boolean>;
  /** Update meshes from XRFrame (call every frame) */
  update: (frame: XRFrame, referenceSpace: XRReferenceSpace) => void;
  /** Show/hide room mesh */
  setVisible: (visible: boolean) => void;
  /** Get all mesh objects for raycasting */
  getMeshes: () => THREE.Mesh[];
  /** Whether mesh detection is supported */
  isSupported: () => boolean;
  /** Cleanup */
  dispose: () => void;
};

export type RoomMeshOptions = {
  scene: THREE.Scene;
  /** Mesh color (default: 0x00ff00 green) */
  color?: number;
  /** Wireframe mode (default: true) */
  wireframe?: boolean;
  /** Opacity (default: 0.5) */
  opacity?: number;
};

// XRMesh type declaration (experimental API)
interface XRMesh {
  readonly meshSpace: XRSpace;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly lastChangedTime: DOMHighResTimeStamp;
}

// Extend XRFrame type
interface XRFrameWithMesh extends XRFrame {
  readonly detectedMeshes?: Set<XRMesh>;
}

/**
 * Room mesh manager using WebXR Mesh Detection API
 * Displays Quest3's scanned room mesh in 3D space
 */
export const createRoomMesh = (options: RoomMeshOptions): RoomMeshHandle => {
  const { scene, color = 0x00ff00, wireframe = true, opacity = 0.5 } = options;

  const meshCache = new Map<XRMesh, THREE.Mesh>();
  let meshDetectionSupported = false;
  let visible = true;

  const start = async (session: XRSession): Promise<boolean> => {
    // Check if mesh-detection feature was successfully enabled
    // The session will have detectedMeshes on frames if supported
    meshDetectionSupported = true;
    console.log("[RoomMesh] Mesh detection initialized");
    return meshDetectionSupported;
  };

  const update = (frame: XRFrame, referenceSpace: XRReferenceSpace) => {
    const frameWithMesh = frame as XRFrameWithMesh;
    const detectedMeshes = frameWithMesh.detectedMeshes;

    if (!detectedMeshes) {
      // Mesh detection not available
      if (meshDetectionSupported) {
        meshDetectionSupported = false;
        console.log("[RoomMesh] Mesh detection not available on this device/browser");
      }
      return;
    }

    if (!meshDetectionSupported) {
      meshDetectionSupported = true;
      console.log("[RoomMesh] Mesh detection is available, detected meshes:", detectedMeshes.size);
    }

    // Track which meshes are still present
    const currentMeshes = new Set<XRMesh>();

    for (const xrMesh of detectedMeshes) {
      currentMeshes.add(xrMesh);

      if (!meshCache.has(xrMesh)) {
        // Create new Three.js mesh
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          "position",
          new THREE.BufferAttribute(xrMesh.vertices, 3)
        );
        geometry.setIndex(new THREE.BufferAttribute(xrMesh.indices, 1));
        geometry.computeVertexNormals();

        const material = new THREE.MeshBasicMaterial({
          color,
          wireframe,
          transparent: true,
          opacity,
          side: THREE.DoubleSide,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.visible = visible;
        mesh.name = `room-mesh-${meshCache.size}`;
        scene.add(mesh);
        meshCache.set(xrMesh, mesh);

        console.log(
          `[RoomMesh] Added mesh with ${xrMesh.vertices.length / 3} vertices, ${xrMesh.indices.length / 3} triangles`
        );
      } else {
        // Check if mesh geometry was updated
        const existingMesh = meshCache.get(xrMesh)!;
        const positionAttr = existingMesh.geometry.getAttribute("position");

        // Update geometry if vertex count changed
        if (positionAttr.count !== xrMesh.vertices.length / 3) {
          existingMesh.geometry.setAttribute(
            "position",
            new THREE.BufferAttribute(xrMesh.vertices, 3)
          );
          existingMesh.geometry.setIndex(
            new THREE.BufferAttribute(xrMesh.indices, 1)
          );
          existingMesh.geometry.computeVertexNormals();
        }
      }

      // Update mesh position and orientation
      const mesh = meshCache.get(xrMesh)!;
      const pose = frame.getPose(xrMesh.meshSpace, referenceSpace);
      if (pose) {
        const { position, orientation } = pose.transform;
        mesh.position.set(position.x, position.y, position.z);
        mesh.quaternion.set(
          orientation.x,
          orientation.y,
          orientation.z,
          orientation.w
        );
      }
    }

    // Remove meshes that are no longer detected
    for (const [xrMesh, mesh] of meshCache) {
      if (!currentMeshes.has(xrMesh)) {
        console.log(`[RoomMesh] Removing mesh: ${mesh.name}`);
        scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        meshCache.delete(xrMesh);
      }
    }
  };

  const setVisible = (v: boolean) => {
    visible = v;
    for (const mesh of meshCache.values()) {
      mesh.visible = v;
    }
  };

  const getMeshes = (): THREE.Mesh[] => {
    return Array.from(meshCache.values());
  };

  const isSupported = () => meshDetectionSupported;

  const dispose = () => {
    for (const mesh of meshCache.values()) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    meshCache.clear();
    console.log("[RoomMesh] Disposed");
  };

  return {
    start,
    update,
    setVisible,
    getMeshes,
    isSupported,
    dispose,
  };
};
