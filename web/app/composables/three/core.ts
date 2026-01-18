import * as THREE from "three";

/**
 * レンダーループ内で毎フレーム呼ばれるコールバック。
 * time は requestAnimationFrame の時間、frame は XR セッション中のみ与えられる。
 */
type RenderCallback = (time: number, frame?: XRFrame) => void;

type ThreeCore = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  start: () => void;
  stop: () => void;
  dispose: () => void;
  onRender: (cb: RenderCallback) => void;
};

/**
 * Three.js の基本セットアップ（Scene/Camera/Renderer + ライト）を生成し、
 * start/stop/dispose をまとめたハンドルを返す。
 */
export const createThreeCore = (canvas: HTMLCanvasElement): ThreeCore => {
  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
  camera.position.z = 1;
  scene.add(camera);

  const ambientLight = new THREE.AmbientLight(0xffffff, 1);
  scene.add(ambientLight);

  const pointLight = new THREE.PointLight(0xffffff, 1.2, 20);
  pointLight.position.set(1.5, 2, 2.5);
  scene.add(pointLight);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
  });

  let isRunning = false;
  let renderCb: RenderCallback = () => {};

  const start = () => {
    if (isRunning) return;
    isRunning = true;
    renderer.setAnimationLoop((time, frame) => {
      renderCb(time, frame);
      renderer.render(scene, camera);
    });
  };

  const stop = () => {
    if (!isRunning) return;
    renderer.setAnimationLoop(null);
    isRunning = false;
  };

  const dispose = () => {
    stop();
    scene.remove(ambientLight);
    scene.remove(pointLight);
    renderer.dispose();
  };

  const onRender = (cb: RenderCallback) => {
    renderCb = cb;
  };

  return {
    scene,
    camera,
    renderer,
    start,
    stop,
    dispose,
    onRender,
  };
};

/**
 * ビューポートリサイズに合わせてレンダラーとカメラを更新する。
 * 返却する関数を呼ぶとリスナーを解除できる。
 */
export const attachResizeHandler = (
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera
) => {
  const resize = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;

    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  resize();
  window.addEventListener("resize", resize);

  return () => window.removeEventListener("resize", resize);
};
