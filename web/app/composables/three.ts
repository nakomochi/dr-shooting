export { createThreeCore, attachResizeHandler } from "./three/core";
export { setupXR } from "./three/xr";
export {
  createWebcamTexture,
  createWebcamBackgroundCover,
} from "./three/webcam";
export { createXRSelectHandler } from "./three/input";
export { loadRifleModel } from "./three/models";
export { createQuest3InputHandler } from "./three/quest";
export { createFireFeedback } from "./three/fire";
export { createReticle } from "./three/reticle";
export { createShotEffectManager } from "./three/shotEffect";
export { createDestructionEffectManager } from "./three/destructionEffect";
export { createDestructionPlaneManager } from "./three/destructionPlane";
export { createScoreDisplay } from "./three/scoreDisplay";

// Segmentation
export { createCameraCapture } from "./three/cameraCapture";
export { createMaskOverlay } from "./three/maskOverlay";
export { createHitTest } from "./three/hitTest";
export { createSegmentationInit } from "./three/segmentationInit";
export { requestSegmentation } from "./segmentation";

// Room mesh (WebXR Mesh Detection)
export { createRoomMesh } from "./three/roomMesh";

// Calibration mode
export { createCalibrationMode } from "./three/calibrationMode";
export { createImageCalibration } from "./three/imageCalibration";
