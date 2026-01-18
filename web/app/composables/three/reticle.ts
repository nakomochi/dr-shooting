import * as THREE from "three";

export type ReticleOptions = {
  /** カメラからの距離（デフォルト: 2） */
  distance?: number;
  /** 中心のドットサイズ（デフォルト: 0.02） */
  centerSize?: number;
  /** クロスヘアの長さ（デフォルト: 0.08） */
  crosshairLength?: number;
  /** リングの半径（デフォルト: [0.06, 0.08, 0.1]） */
  ringRadii?: number[];
  /** リングの回転速度（デフォルト: [1, -0.7, 0.5]） */
  ringSpeeds?: number[];
};

/**
 * 3D照準（レティクル）を作成する
 * カメラの前に常に表示され、ポインタ位置に追従する
 */
export const createReticle = (options: ReticleOptions = {}) => {
  const {
    distance = 2,
    centerSize = 0.02,
    crosshairLength = 0.08,
    ringRadii = [0.06, 0.08, 0.1],
    ringSpeeds = [1, -0.7, 0.5],
  } = options;

  // レティクル全体のグループ
  const reticle = new THREE.Group();
  reticle.name = "reticle";

  // 中心のドット（赤）
  const centerGeometry = new THREE.CircleGeometry(centerSize, 16);
  const centerMaterial = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
  });
  const centerDot = new THREE.Mesh(centerGeometry, centerMaterial);
  centerDot.renderOrder = 999;
  reticle.add(centerDot);

  // クロスヘア（十字線）- 白の点線風
  const crosshairMaterial = new THREE.LineBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.5,
    depthTest: false,
  });

  // 縦線
  const verticalPoints = [
    new THREE.Vector3(0, -crosshairLength, 0),
    new THREE.Vector3(0, crosshairLength, 0),
  ];
  const verticalGeometry = new THREE.BufferGeometry().setFromPoints(verticalPoints);
  const verticalLine = new THREE.Line(verticalGeometry, crosshairMaterial);
  verticalLine.renderOrder = 999;
  reticle.add(verticalLine);

  // 横線
  const horizontalPoints = [
    new THREE.Vector3(-crosshairLength, 0, 0),
    new THREE.Vector3(crosshairLength, 0, 0),
  ];
  const horizontalGeometry = new THREE.BufferGeometry().setFromPoints(horizontalPoints);
  const horizontalLine = new THREE.Line(horizontalGeometry, crosshairMaterial);
  horizontalLine.renderOrder = 999;
  reticle.add(horizontalLine);

  // 回転リング（半円弧）
  const rings: THREE.Line[] = [];
  ringRadii.forEach((radius, index) => {
    const ringMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.5,
      depthTest: false,
    });

    // 半円弧を作成（上半分）
    const curve = new THREE.EllipseCurve(
      0, 0,           // 中心
      radius, radius, // X半径, Y半径
      0, Math.PI,     // 開始角度, 終了角度（上半分）
      false,          // 時計回りか
      0               // 回転
    );
    const points = curve.getPoints(32);
    const ringGeometry = new THREE.BufferGeometry().setFromPoints(points);
    const ring = new THREE.Line(ringGeometry, ringMaterial);
    ring.renderOrder = 999;
    ring.userData.speed = ringSpeeds[index] || 1;
    rings.push(ring);
    reticle.add(ring);
  });

  // 更新関数（毎フレーム呼び出す）
  const update = (
    camera: THREE.Camera,
    pointerX: number, // -1 to 1
    pointerY: number, // -1 to 1
    deltaTime: number // 秒
  ) => {
    // ポインタ位置からワールド座標を計算
    const ndc = new THREE.Vector3(pointerX, pointerY, 0.5);
    ndc.unproject(camera);
    const direction = ndc.sub(camera.position).normalize();

    // カメラからdistance離れた位置にレティクルを配置
    reticle.position.copy(camera.position).add(direction.multiplyScalar(distance));

    // カメラの方を向く
    reticle.lookAt(camera.position);

    // リングを回転
    rings.forEach((ring) => {
      ring.rotation.z += ring.userData.speed * deltaTime;
    });
  };

  const dispose = () => {
    reticle.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.Line) {
        child.geometry.dispose();
        if (child.material instanceof THREE.Material) {
          child.material.dispose();
        }
      }
    });
  };

  return {
    reticle,
    update,
    dispose,
  };
};
