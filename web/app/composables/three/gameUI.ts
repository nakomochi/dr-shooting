import * as THREE from "three";

export type GameUIPhase = 'capture' | 'loading' | null;

export type GameUIOptions = {
  /** Distance from camera (default: 1.2) */
  distance?: number;
  /** Scale of the sprite (default: 0.5) */
  scale?: number;
};

/**
 * Creates a 3D game UI that displays capture/loading screens
 * Uses CanvasTexture to render UI as a sprite that follows the camera
 */
export const createGameUI = (options: GameUIOptions = {}) => {
  const {
    distance = 1.2,
    scale = 0.5,
  } = options;

  // Create canvas for UI rendering
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  canvas.width = 512;
  canvas.height = 256;

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
  sprite.renderOrder = 1001;
  sprite.scale.set(scale * 2, scale, 1); // Aspect ratio 2:1
  sprite.visible = false;

  let currentPhase: GameUIPhase = null;
  let animationTime = 0;

  /**
   * Draw capture screen UI
   */
  const drawCapture = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background panel
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.beginPath();
    ctx.roundRect(80, 40, 352, 176, 20);
    ctx.fill();

    // Title text
    ctx.fillStyle = "white";
    ctx.font = "bold 32px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Position your view", 256, 85);

    // Instruction text
    ctx.font = "22px sans-serif";
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    ctx.fillText("Pull trigger to capture", 256, 125);

    // Animated pulse ring
    const pulse = 0.5 + 0.5 * Math.sin(animationTime * 4);
    const ringRadius = 18 + pulse * 8;
    const ringAlpha = 0.4 + pulse * 0.4;

    ctx.strokeStyle = `rgba(255, 255, 255, ${ringAlpha})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(256, 175, ringRadius, 0, Math.PI * 2);
    ctx.stroke();

    // Inner static ring
    ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(256, 175, 12, 0, Math.PI * 2);
    ctx.stroke();

    texture.needsUpdate = true;
  };

  /**
   * Draw loading screen UI
   */
  const drawLoading = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background panel
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.beginPath();
    ctx.roundRect(140, 60, 232, 136, 20);
    ctx.fill();

    // Spinner
    const spinnerRadius = 24;
    const spinnerX = 256;
    const spinnerY = 115;
    const angle = animationTime * 6;

    ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(spinnerX, spinnerY, spinnerRadius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = "white";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(spinnerX, spinnerY, spinnerRadius, angle, angle + Math.PI * 1.2);
    ctx.stroke();

    // Loading text
    ctx.fillStyle = "white";
    ctx.font = "20px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Analyzing...", 256, 165);

    texture.needsUpdate = true;
  };

  /**
   * Set the current UI phase
   */
  const setPhase = (phase: GameUIPhase) => {
    currentPhase = phase;
    sprite.visible = phase !== null;
    animationTime = 0;

    // Draw initial frame
    if (phase === 'capture') drawCapture();
    else if (phase === 'loading') drawLoading();
  };

  /**
   * Update sprite position and animation
   */
  const update = (camera: THREE.Camera, deltaTime: number) => {
    if (!currentPhase) return;

    animationTime += deltaTime;

    // Get camera's forward vector
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);

    // Position sprite in front of camera
    sprite.position
      .copy(camera.position)
      .add(forward.multiplyScalar(distance));

    // Make sprite face camera
    sprite.quaternion.copy(camera.quaternion);

    // Redraw for animation
    if (currentPhase === 'capture') drawCapture();
    else if (currentPhase === 'loading') drawLoading();
  };

  const dispose = () => {
    texture.dispose();
    material.dispose();
  };

  return {
    sprite,
    setPhase,
    update,
    dispose,
  };
};
