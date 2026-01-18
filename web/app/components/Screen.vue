<template>
  <div>
    <canvas ref="canvasRef" class="three-screen"></canvas>
  </div>
</template>

<script setup lang="ts">
import {
  attachResizeHandler,
  createThreeCore,
  createWebcamBackgroundCover,
  createQuest3InputHandler,
  createFireFeedback,
  loadRifleModel,
  setupXR,
  createReticle,
  createShotEffectManager,
  createDestructionEffectManager,
  createDestructionPlaneManager,
  createScoreDisplay,
  sendShotAndApplyBackground,
  createSegmentationInit,
} from '~/composables/three';
import { usePointerState, nudgePointer } from '~/composables/pointer';
import * as THREE from 'three';

const canvasRef = ref<HTMLCanvasElement | null>(null);
const cleanups: Array<() => void> = [];
const pointer = usePointerState();
const bgUrlHolder = { current: null as string | null };

onMounted(async () => {
  const canvas = canvasRef.value;
  if (!canvas) return;

  const three = createThreeCore(canvas);
  cleanups.push(three.dispose);

  const stopResize = attachResizeHandler(three.renderer, three.camera);
  cleanups.push(stopResize);

  // Fire feedback (screen shake + haptics)
  const { fire: handleFire } = createFireFeedback({
    canvasRef,
    getXRSession: () => three.renderer.xr.getSession(),
    options: {
      shakeIntensity: 32,
      shakeDuration: 240,
      hapticDuration: 100,
      hapticStrength: 0.6,
    },
  });

  // Segmentation initialization (AR mode only) - declare early for shotEffect reference
  let segmentationInit: ReturnType<typeof createSegmentationInit> | null = null;

  // Score tracking
  let destroyedCount = 0;
  let totalCount = 0;

  // Score display (3D sprite)
  const scoreDisplay = createScoreDisplay({
    distance: 1.5,
    offsetX: -0.7,
    offsetY: 0.5,
    scale: 0.12,
  });
  three.scene.add(scoreDisplay.sprite);
  cleanups.push(() => {
    three.scene.remove(scoreDisplay.sprite);
    scoreDisplay.dispose();
  });

  // Destruction particle effect
  const destructionEffect = createDestructionEffectManager(three.scene, {
    particleCount: 40,
    spreadSpeed: 0.4,
    duration: 600,
    particleSize: 0.025,
    gravity: 3,
  });
  cleanups.push(destructionEffect.dispose);

  // White plane that appears when mask is destroyed
  const destructionPlane = createDestructionPlaneManager(three.scene, {
    scaleMultiplier: 1.1,
  });
  cleanups.push(destructionPlane.dispose);

  // 3D shot effect (bullet flying from gun to reticle)
  const shotEffect = createShotEffectManager(three.scene, {
    duration: 300,
    bulletSize: 0.02,
    color: 0xffff00,
    getMasks: () => {
      if (!segmentationInit?.isReady()) return [];
      const overlay = segmentationInit.getMaskOverlay();
      return overlay?.getMasks() ?? [];
    },
    onHit: (result) => {
      console.log(`[Hit] Mask ${result.maskId} at`, result.position.toArray());
      const overlay = segmentationInit?.getMaskOverlay();

      // Spawn white plane with same shape as destroyed mask
      destructionPlane.spawn(result.mask);

      overlay?.hideMask(result.maskId);
      destructionEffect.spawn(result.position, 0xff6600);
      // Update score
      destroyedCount++;
      scoreDisplay.updateScore(destroyedCount, totalCount);
    },
  });
  cleanups.push(shotEffect.dispose);

  // Get gun tip position in world coordinates
  const getGunTipPosition = (rifleModel: THREE.Object3D | null): THREE.Vector3 => {
    if (!rifleModel) {
      return three.camera.position.clone().add(
        new THREE.Vector3(0.5, -0.3, -0.5).applyQuaternion(three.camera.quaternion)
      );
    }
    // Offset from rifle origin: X=left/right, Y=up/down, Z=forward(negative)
    const tipOffset = new THREE.Vector3(0, 0.1, -7);
    return tipOffset.clone().applyMatrix4(rifleModel.matrixWorld);
  };

  // Get target position for bullet (beyond the masks at 2.5m, so bullet passes through)
  const getTargetPosition = (): THREE.Vector3 => {
    const ndc = new THREE.Vector3(pointer.value.x, pointer.value.y, 0.5);
    ndc.unproject(three.camera);
    const direction = ndc.sub(three.camera.position).normalize();
    // Shoot further than mask distance (2.5m) to ensure bullet can hit masks
    return three.camera.position.clone().add(direction.multiplyScalar(5));
  };

  let rifle: THREE.Object3D | null = null;

  const handleFireWithEffects = async () => {
    handleFire();
    shotEffect.fire(getGunTipPosition(rifle), getTargetPosition());
    try {
      await sendShotAndApplyBackground({
        canvasRef,
        pointer,
        previousUrl: bgUrlHolder,
      });
    } catch (error) {
      console.error('Failed to send shot data', error);
    }
  };

  // Keyboard input for pointer movement (non-XR fallback)
  const keyState = new Set<string>();
  const onKeyDown = (e: KeyboardEvent) => keyState.add(e.key.toLowerCase());
  const onKeyUp = (e: KeyboardEvent) => keyState.delete(e.key.toLowerCase());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  cleanups.push(() => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  });

  // Quest 3 input handler (XR and fallback)
  const questInput = createQuest3InputHandler(() => handleFireWithEffects());
  questInput.attachFallback(window);
  const onSessionStart = () => {
    const session = three.renderer.xr.getSession();
    if (session) {
      questInput.detach();
      questInput.attachXR(session);
    }
  };
  const onSessionEnd = () => {
    questInput.detach();
    questInput.attachFallback(window);
  };
  three.renderer.xr.addEventListener('sessionstart', onSessionStart);
  three.renderer.xr.addEventListener('sessionend', onSessionEnd);
  cleanups.push(() => {
    three.renderer.xr.removeEventListener('sessionstart', onSessionStart);
    three.renderer.xr.removeEventListener('sessionend', onSessionEnd);
    questInput.detach();
  });

  const useAR = navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar'));

  // Use webcam as background when AR is not available
  if (!useAR) {
    try {
      const webcam = await createWebcamBackgroundCover(three.scene, three.camera);
      cleanups.push(webcam.dispose);
    } catch (error) {
      console.error('Failed to init webcam', error);
    }
  }

  // Load rifle model
  try {
    const { model, dispose } = await loadRifleModel({
      position: [0.75, -0.75, -0.5],
      rotation: [Math.PI / 16, -Math.PI / 9 * 8.5, 0],
      scale: 2.5,
      center: false,
    });
    rifle = model;
    three.scene.add(model);
    cleanups.push(() => {
      three.scene.remove(model);
      dispose();
    });
  } catch (error) {
    console.error('Failed to load rifle model', error);
  }

  // 3D reticle (same distance as masks: 2.5m)
  const reticleObj = createReticle({
    distance: 2.5,
    centerSize: 0.015,
    crosshairLength: 0.06,
    ringRadii: [0.04, 0.055, 0.07],
    ringSpeeds: [1.2, -0.8, 0.5],
  });
  three.scene.add(reticleObj.reticle);
  cleanups.push(() => {
    three.scene.remove(reticleObj.reticle);
    reticleObj.dispose();
  });

  // WebXR button
  const xrCleanup = setupXR(three.renderer, useAR ? 'ar' : 'vr');
  cleanups.push(xrCleanup);

  // Segmentation initialization (AR mode only)
  if (useAR) {
    segmentationInit = createSegmentationInit({
      scene: three.scene,
      camera: three.camera,
      renderer: three.renderer,
      maskOpacity: 0.4,
      maskDistance: 2.5,
      cameraFov: 97,
      scaleFactor: 0.5,
      offsetX: -0.1,
      offsetY: -0.2,
    });
    cleanups.push(() => segmentationInit?.dispose());

    // Initialize segmentation when XR session starts
    let segmentationInitialized = false;
    const initSegmentation = () => {
      const session = three.renderer.xr.getSession();
      if (!session || segmentationInitialized) return;

      // Wait for first frame to get XRFrame
      session.requestAnimationFrame(async (_time, frame) => {
        if (!segmentationInitialized && frame && segmentationInit) {
          segmentationInitialized = true;
          await segmentationInit.initialize(frame);
          // Update total count after segmentation is ready
          totalCount = segmentationInit.getMaskOverlay()?.getMaskCount() ?? 0;
          scoreDisplay.updateScore(destroyedCount, totalCount);
        }
      });
    };

    three.renderer.xr.addEventListener('sessionstart', initSegmentation);
    cleanups.push(() => {
      three.renderer.xr.removeEventListener('sessionstart', initSegmentation);
    });
  }

  // Render loop
  let prevTime = 0;
  const pointerSpeed = 1.6;

  const updatePointerFromXR = (frame?: XRFrame, deltaSec = 0) => {
    const session = frame?.session || three.renderer.xr.getSession();
    if (!session) return;
    for (const source of session.inputSources) {
      const axes = source.gamepad?.axes;
      if (!axes || axes.length < 2) continue;
      const dx = axes[0]! * pointerSpeed * deltaSec;
      const dy = -axes[1]! * pointerSpeed * deltaSec;
      nudgePointer(dx, dy);
      return;
    }
  };

  const updatePointerFromKeyboard = (deltaSec: number) => {
    let dx = 0;
    let dy = 0;
    if (keyState.has('arrowleft') || keyState.has('a')) dx -= 1;
    if (keyState.has('arrowright') || keyState.has('d')) dx += 1;
    if (keyState.has('arrowup') || keyState.has('w')) dy += 1;
    if (keyState.has('arrowdown') || keyState.has('s')) dy -= 1;
    if (dx !== 0 || dy !== 0) {
      const len = Math.hypot(dx, dy) || 1;
      nudgePointer((dx / len) * pointerSpeed * deltaSec, (dy / len) * pointerSpeed * deltaSec);
    }
  };

  const aimRifle = () => {
    if (!rifle) return;
    const { x, y } = pointer.value;
    const ndc = new THREE.Vector3(x, y, 0.5);
    ndc.unproject(three.camera);
    const dir = ndc.sub(three.camera.position).normalize();
    const target = new THREE.Vector3().copy(rifle.position).add(dir);
    rifle.lookAt(target);
  };

  three.onRender((time, frame) => {
    const deltaSec = prevTime ? (time - prevTime) / 1000 : 0;
    prevTime = time;
    updatePointerFromXR(frame, deltaSec);
    updatePointerFromKeyboard(deltaSec);
    aimRifle();
    reticleObj.update(three.camera, pointer.value.x, pointer.value.y, deltaSec);
    shotEffect.update();
    destructionEffect.update();

    // Update score display position to follow camera
    const xrCamera = three.renderer.xr.isPresenting ? three.renderer.xr.getCamera() : three.camera;
    scoreDisplay.update(xrCamera);

    // Update segmentation mask anchors
    if (frame && segmentationInit?.isReady()) {
      segmentationInit.update(frame);
    }
  });

  three.start();
});

onBeforeUnmount(() => {
  cleanups.splice(0).forEach((fn) => fn());
  if (bgUrlHolder.current) URL.revokeObjectURL(bgUrlHolder.current);
});
</script>

<style scoped>
.three-screen {
  display: block;
  width: 100vw;
  height: 100vh;
}
</style>
