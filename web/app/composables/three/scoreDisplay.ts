import * as THREE from "three";

export type ScoreDisplayOptions = {
  /** Distance from camera (default: 1.5) */
  distance?: number;
  /** Horizontal offset from center in NDC (-1 to 1, default: -0.7) */
  offsetX?: number;
  /** Vertical offset from center in NDC (-1 to 1, default: 0.5) */
  offsetY?: number;
  /** Scale of the sprite (default: 0.15) */
  scale?: number;
};

/**
 * Creates a 3D score display that follows the camera
 * Uses CanvasTexture to render text as a sprite
 */
export const createScoreDisplay = (options: ScoreDisplayOptions = {}) => {
  const {
    distance = 1.5,
    offsetX = -0.7,
    offsetY = 0.5,
    scale = 0.15,
  } = options;

  // Create canvas for text rendering
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  canvas.width = 256;
  canvas.height = 64;

  // Create texture and sprite
  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });

  const sprite = new THREE.Sprite(material);
  sprite.renderOrder = 1000;
  sprite.scale.set(scale * 4, scale, 1); // Aspect ratio ~4:1

  let currentDestroyed = 0;
  let currentTotal = 0;

  /**
   * Render text to canvas
   */
  const renderText = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background rounded rectangle
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.beginPath();
    ctx.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 12);
    ctx.fill();

    // Text
    ctx.fillStyle = "white";
    ctx.font = "bold 36px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(`${currentDestroyed}/${currentTotal}`, canvas.width / 2, canvas.height / 2);

    texture.needsUpdate = true;
  };

  /**
   * Update the score display
   */
  const updateScore = (destroyed: number, total: number) => {
    if (destroyed !== currentDestroyed || total !== currentTotal) {
      currentDestroyed = destroyed;
      currentTotal = total;
      renderText();
    }
  };

  /**
   * Update sprite position to follow camera
   */
  const update = (camera: THREE.Camera) => {
    // Get camera's forward, right, and up vectors
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);

    // Position sprite in front of camera with offset
    sprite.position
      .copy(camera.position)
      .add(forward.multiplyScalar(distance))
      .add(right.multiplyScalar(offsetX * distance * 0.5))
      .add(up.multiplyScalar(offsetY * distance * 0.5));

    // Make sprite face camera
    sprite.quaternion.copy(camera.quaternion);
  };

  const dispose = () => {
    texture.dispose();
    material.dispose();
  };

  // Initial render
  renderText();

  return {
    sprite,
    update,
    updateScore,
    dispose,
  };
};
