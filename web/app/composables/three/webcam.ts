import * as THREE from "three";

/**
 * ウェブカメラ映像を VideoTexture として扱うためのハンドル。
 * dispose でストリームとテクスチャをまとめて解放できる。
 */
export type WebcamHandle = {
  texture: THREE.VideoTexture;
  stream: MediaStream;
  video: HTMLVideoElement;
  dispose: () => void;
};

/**
 * getUserMedia でカメラを開き、VideoTexture を返す。
 * 呼び出し元で dispose を必ず実行してリソースを解放すること。
 */
export const createWebcamTexture = async (): Promise<WebcamHandle> => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });

  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();

  if (video.readyState < 2) {
    await new Promise((resolve) =>
      video.addEventListener("loadedmetadata", resolve, { once: true })
    );
  }

  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;

  const dispose = () => {
    texture.dispose();
    stream.getTracks().forEach((track) => track.stop());
    video.pause();
    video.srcObject = null;
  };

  return { texture, stream, video, dispose };
};

/**
 * ウェブカメラ映像を画面全面の背景メッシュとして配置する。
 * カメラの FoV とビューポート比率に応じてスケールを自動調整する。
 */
export const createWebcamBackgroundCover = async (
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera
) => {
  const webcam = await createWebcamTexture();

  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial({
    map: webcam.texture,
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -1;
  mesh.position.set(0, 0, camera.position.z - 1);
  scene.add(mesh);

  const updateCoverScale = () => {
    const videoAspect = webcam.video.videoWidth / webcam.video.videoHeight || 1;
    const viewportAspect = window.innerWidth / window.innerHeight || 1;

    const distance = Math.max(
      Math.abs(camera.position.z - mesh.position.z),
      0.0001
    );

    const height = 2 * distance * Math.tan((camera.fov * Math.PI) / 180 / 2);
    const width = height * viewportAspect;

    let planeWidth = width;
    let planeHeight = height;

    if (videoAspect > viewportAspect) {
      planeHeight = height;
      planeWidth = height * videoAspect;
    } else {
      planeWidth = width;
      planeHeight = width / videoAspect;
    }

    mesh.scale.set(planeWidth, planeHeight, 1);
  };

  updateCoverScale();
  window.addEventListener("resize", updateCoverScale);

  const dispose = () => {
    window.removeEventListener("resize", updateCoverScale);
    scene.remove(mesh);
    geometry.dispose();
    material.dispose();
    webcam.dispose();
  };

  return {
    ...webcam,
    mesh,
    dispose,
  };
};
