import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * モデル読み込み後に適用する座標・回転・スケール指定。
 * 配列指定は [x, y, z] で渡す。
 */
export type ModelTransformOptions = {
  position?: THREE.Vector3 | [number, number, number];
  rotation?: THREE.Euler | [number, number, number];
  scale?: number | [number, number, number];
  center?: boolean;
};

/** GLTF 読み込み結果と破棄用の関数 */
export type LoadedModel = {
  model: THREE.Object3D;
  dispose: () => void;
};

const gltfLoader = new GLTFLoader();

/**
 * 読み込んだモデルに位置・回転・スケールを適用するヘルパー。
 * center が true の場合、バウンディングボックス中心を原点へ移動する。
 */
const applyTransforms = (
  object: THREE.Object3D,
  options: ModelTransformOptions = {}
) => {
  const { position, rotation, scale, center = true } = options;

  if (center) {
    const box = new THREE.Box3().setFromObject(object);
    const centerVec = box.getCenter(new THREE.Vector3());
    object.position.sub(centerVec);
  }

  if (position) {
    const pos = Array.isArray(position)
      ? new THREE.Vector3(...position)
      : position;
    object.position.copy(pos);
  }

  if (rotation) {
    const rot = Array.isArray(rotation)
      ? new THREE.Euler(...rotation)
      : rotation;
    object.rotation.copy(rot);
  }

  if (scale !== undefined) {
    if (Array.isArray(scale)) {
      object.scale.set(scale[0], scale[1], scale[2]);
    } else {
      object.scale.setScalar(scale);
    }
  }
};

/**
 * public/models/rifle.glb を読み込み、任意の Transform を適用した Object3D を返す。
 * dispose でジオメトリとマテリアルを解放すること。
 */
export const loadRifleModel = async (
  options?: ModelTransformOptions
): Promise<LoadedModel> => {
  const gltf = await gltfLoader.loadAsync("/models/rifle.glb");
  const model = gltf.scene;
  applyTransforms(model, options);

  const dispose = () => {
    model.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;

      child.geometry.dispose();

      const materials = Array.isArray(child.material)
        ? child.material
        : [child.material];

      materials.forEach((material) => {
        if (!material) return;

        const mat = material as THREE.Material & {
          map?: THREE.Texture;
          lightMap?: THREE.Texture;
          bumpMap?: THREE.Texture;
          normalMap?: THREE.Texture;
          displacementMap?: THREE.Texture;
          roughnessMap?: THREE.Texture;
          metalnessMap?: THREE.Texture;
        };

        mat.map?.dispose();
        mat.lightMap?.dispose();
        mat.bumpMap?.dispose();
        mat.normalMap?.dispose();
        mat.displacementMap?.dispose();
        mat.roughnessMap?.dispose();
        mat.metalnessMap?.dispose();
        mat.dispose();
      });
    });
  };

  return { model, dispose };
};
