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
  createSegmentationInit,
  createRoomMesh,
  createCalibrationMode,
  createImageCalibration,
  createGameUI,
  createHintArrow,
  type DepthMode,
} from '~/composables/three';
import { usePointerState, nudgePointer } from '~/composables/pointer';
import { useGamePhase, setGamePhase, updateGameScore, resetGamePhase } from '~/composables/gamePhase';
import * as THREE from 'three';

const canvasRef = ref<HTMLCanvasElement | null>(null);
const cleanups: Array<() => void> = [];
const pointer = usePointerState();
const gamePhase = useGamePhase();
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

  // Room mesh manager (AR mode only) - displays Quest3 scanned mesh
  let roomMesh: ReturnType<typeof createRoomMesh> | null = null;

  // Calibration mode (AR mode only) - for adjusting mask positions
  type CalibrationModeHandle = ReturnType<typeof createCalibrationMode>;
  type ImageCalibrationHandle = ReturnType<typeof createImageCalibration>;
  let calibrationMode = null as CalibrationModeHandle | null;
  let imageCalibration = null as ImageCalibrationHandle | null;
  let calibrationCompleted = false;

  // Score tracking
  let destroyedCount = 0;
  let totalCount = 0;

  // Completed phase cooldown (prevent accidental restart from trigger spam)
  let completedTime = 0;
  const RESTART_COOLDOWN_MS = 3000;

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

  // Game UI (3D sprite for capture/loading screens)
  const gameUI = createGameUI({
    distance: 1.2,
    scale: 0.5,
  });
  three.scene.add(gameUI.sprite);
  cleanups.push(() => {
    three.scene.remove(gameUI.sprite);
    gameUI.dispose();
  });

  // Hint arrow (points to nearest mask after idle time)
  const hintArrow = createHintArrow({
    distance: 0.8,
    idleTime: 5,
    color: 0xffff00,
  });
  three.scene.add(hintArrow.arrow);
  cleanups.push(() => {
    three.scene.remove(hintArrow.arrow);
    hintArrow.dispose();
  });

  // Destruction particle effect
  const destructionEffect = createDestructionEffectManager(three.scene, {
    particleCount: 40,
    maskParticleCount: 120,
    spreadSpeed: 0.5,
    duration: 800,
    particleSize: 0.025,
    gravity: 2.5,
  });
  cleanups.push(destructionEffect.dispose);

  // White plane that appears when mask is destroyed
  const destructionPlane = createDestructionPlaneManager(three.scene, {
    scaleMultiplier: 1.1,
    getCombinedInpaintData: () => segmentationInit?.getCombinedInpaintData() ?? null,
    getImageSize: () => segmentationInit?.getImageSize() ?? null,
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

      // Get inpaint data from the mask
      const masks = overlay?.getMasks() ?? [];
      const hitMaskData = masks.find((m) => m.maskId === result.maskId);

      // Spawn plane with inpaint texture (or white fallback)
      destructionPlane.spawn(
        result.mask,
        hitMaskData?.inpaintData,
        hitMaskData?.inpaintBbox,
        hitMaskData?.originalBbox
      );

      overlay?.hideMask(result.maskId);
      // Spawn particles from entire mask surface (uses mask's color)
      destructionEffect.spawnFromMask(result.mask, result.position);
      // Update score
      destroyedCount++;
      scoreDisplay.updateScore(destroyedCount, totalCount);
      updateGameScore(destroyedCount, totalCount);

      // Reset hint arrow timer on destroy
      hintArrow.onDestroy();

      // Check for game completion
      if (destroyedCount >= totalCount && totalCount > 0) {
        setGamePhase('completed');
        gameUI.setPhase('completed', destroyedCount, totalCount);
        completedTime = performance.now();
      }
    },
  });
  cleanups.push(shotEffect.dispose);

  // Get gun tip position in world coordinates
  const getGunTipPosition = (rifleModel: THREE.Object3D | null): THREE.Vector3 => {
    if (!rifleModel) {
      return three.camera.position.clone().add(
        new THREE.Vector3(0.25, -0.35, -0.4).applyQuaternion(three.camera.quaternion)
      );
    }
    // Offset from rifle origin: X=left/right, Y=up/down, Z=forward(negative)
    // Adjusted for scale 0.08 (barrel tip is about 0.2m forward from grip)
    const tipOffset = new THREE.Vector3(0, 0.003, 0);
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

  // Flag to prevent double-capture
  let captureTriggered = false;

  // Trigger capture (called when user pulls trigger in capture phase)
  // This function is defined here but needs calibration constants, so we'll update it in the AR block
  let triggerCaptureImpl: (() => Promise<void>) | null = null;
  const triggerCapture = async () => {
    if (triggerCaptureImpl) {
      await triggerCaptureImpl();
    }
  };

  // Function to recreate segmentationInit (set in AR block)
  let recreateSegmentationInit: (() => void) | null = null;

  const handleFireWithEffects = async () => {
    const phase = gamePhase.value.phase;

    // In capture phase, trigger capture instead of shooting
    if (phase === 'capture') {
      triggerCapture();
      return;
    }

    // In loading phase, do nothing
    if (phase === 'loading') {
      return;
    }

    // In completed phase, restart the game (go back to capture)
    if (phase === 'completed') {
      // Check cooldown - prevent restart for 3 seconds after completion
      if (performance.now() - completedTime < RESTART_COOLDOWN_MS) {
        return;
      }

      // Reset game state
      destroyedCount = 0;
      totalCount = 0;
      anchorsCreated = false;
      captureTriggered = false;
      calibrationCompleted = false;

      // Reset hint arrow
      hintArrow.reset();

      // Clear cached inpaint texture (so next game uses new capture)
      destructionPlane.clearCache();

      // Clear existing masks and recreate segmentationInit
      segmentationInit?.dispose();
      if (recreateSegmentationInit) {
        recreateSegmentationInit();
      }

      // Transition to capture phase
      setGamePhase('capture');
      gameUI.setPhase('capture');
      scoreDisplay.updateScore(0, 0);
      updateGameScore(0, 0);
      return;
    }

    // In image calibration mode, trigger confirms the calibration
    if (imageCalibration?.isActive()) {
      imageCalibration.confirm();
      return;
    }

    // In mask calibration mode, trigger confirms current mask position
    if (calibrationMode?.isActive()) {
      calibrationMode.confirmCurrent();
      return;
    }

    handleFire();
    shotEffect.fire(getGunTipPosition(rifle), getTargetPosition());
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
  // Position: shoulder-mounted rifle position (slightly right and down from eye level)
  try {
    const { model, dispose } = await loadRifleModel({
      position: [0.2, -0.3, 0],
      rotation: [-Math.PI / 32, -Math.PI / 9 * 8.5, 0],
      scale: 0.8,
      center: false,
    });
    rifle = model;
    // Attach to camera instead of scene - gun follows player's head
    three.camera.add(model);
    cleanups.push(() => {
      three.camera.remove(model);
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
    // Room mesh manager for displaying Quest3 scanned mesh
    // Create this first so we can pass it to segmentationInit
    roomMesh = createRoomMesh({
      scene: three.scene,
      color: 0x00ff00,  // Green
      wireframe: true,
      opacity: 0.5,
    });
    roomMesh.setVisible(false);  // Hide mesh display (still used for raycasting)
    cleanups.push(() => roomMesh?.dispose());

    // Calibration parameters (from image calibration average of 2 tests)
    const CALIBRATION_SCALE_FACTOR = 0.47;
    const CALIBRATION_OFFSET_X = -0.024;
    const CALIBRATION_OFFSET_Y = -0.203;
    const IS_CALIBRATION_MODE = false;

    // Depth mode: 'none' = fixed distance, 'center' = raycast at mask center, 'multi-point' = raycast at multiple points
    // Set to 'none' to disable depth-based positioning (uses fixed 2.5m distance)
    const DEPTH_MODE = 'center' as DepthMode;

    // Factory function to create segmentationInit (allows recreation on restart)
    const createSegmentationInitInstance = () => createSegmentationInit({
      scene: three.scene,
      camera: three.camera,
      renderer: three.renderer,
      maskOpacity: 0.4,
      maskDistance: 2.5,
      cameraFov: 97,
      scaleFactor: IS_CALIBRATION_MODE ? 1.0 : CALIBRATION_SCALE_FACTOR,
      offsetX: IS_CALIBRATION_MODE ? 0 : CALIBRATION_OFFSET_X,
      offsetY: IS_CALIBRATION_MODE ? 0 : CALIBRATION_OFFSET_Y,
      roomMesh: roomMesh,
      useMeshPositioning: DEPTH_MODE !== 'none',
      depthMode: DEPTH_MODE,
      captureOnly: IS_CALIBRATION_MODE, // Skip segmentation API in calibration mode
    });

    segmentationInit = createSegmentationInitInstance();
    cleanups.push(() => segmentationInit?.dispose());

    // Allow recreation of segmentationInit on restart
    recreateSegmentationInit = () => {
      segmentationInit = createSegmentationInitInstance();
    };

    // Implement capture trigger with access to calibration constants
    triggerCaptureImpl = async () => {
      if (captureTriggered) return;
      captureTriggered = true;

      const session = three.renderer.xr.getSession();
      if (!session || !segmentationInit) {
        captureTriggered = false;
        return;
      }

      setGamePhase('loading');
      gameUI.setPhase('loading');

      // Wait for next frame to get XRFrame
      session.requestAnimationFrame(async (_time, frame) => {
        if (!frame || !segmentationInit) {
          setGamePhase('capture');
          gameUI.setPhase('capture');
          captureTriggered = false;
          return;
        }

        // Initialize segmentation (camera capture + server request)
        await segmentationInit.initialize(frame);

        // Update total count after segmentation is ready
        totalCount = segmentationInit.getMaskOverlay()?.getMaskCount() ?? 0;
        scoreDisplay.updateScore(destroyedCount, totalCount);
        updateGameScore(destroyedCount, totalCount);

        // Start calibration mode after segmentation is ready (only in calibration mode)
        if (IS_CALIBRATION_MODE) {
          const capturedImage = segmentationInit.getCapturedImageData();
          const imageSize = segmentationInit.getImageSize();
          if (capturedImage && imageSize) {
            // Hide all masks during calibration - focus only on image calibration
            segmentationInit.setVisible(false);

            // Use image-based calibration: display captured image as transparent overlay
            imageCalibration = createImageCalibration({
              scene: three.scene,
              camera: three.camera,
              renderer: three.renderer,
              imageData: capturedImage,
              imageSize,
              initialDistance: 2.5,
              initialOffsetX: CALIBRATION_OFFSET_X,
              initialOffsetY: CALIBRATION_OFFSET_Y,
              initialScale: CALIBRATION_SCALE_FACTOR,
              capturePosition: segmentationInit.getCapturePosition() ?? undefined,
              captureQuaternion: segmentationInit.getCaptureQuaternion() ?? undefined,
              cameraFov: 97,
              onComplete: (params) => {
                console.log('[Screen] Image calibration complete!');
                console.log('[Screen] offsetX:', params.offsetX.toFixed(4));
                console.log('[Screen] offsetY:', params.offsetY.toFixed(4));
                console.log('[Screen] scale:', params.scale.toFixed(4));
                calibrationCompleted = true;
              },
            });
            imageCalibration.start();
            cleanups.push(() => imageCalibration?.dispose());
          }
        } else {
          calibrationCompleted = true;
        }

        // Transition to playing phase
        setGamePhase('playing');
        gameUI.setPhase(null);
      });
    };

    // When XR session starts, transition to capture phase (no auto-segmentation)
    const onARSessionStart = async () => {
      const session = three.renderer.xr.getSession();
      if (!session) return;

      // Start room mesh detection
      if (roomMesh) {
        const meshSupported = await roomMesh.start(session);
        console.log('[Screen] Room mesh detection supported:', meshSupported);
      }

      // Transition to capture phase - user will trigger capture manually
      setGamePhase('capture');
      gameUI.setPhase('capture');
    };

    const onARSessionEnd = () => {
      // Reset game phase when session ends
      resetGamePhase();
      gameUI.setPhase(null);
      captureTriggered = false;
      calibrationCompleted = false;
    };

    three.renderer.xr.addEventListener('sessionstart', onARSessionStart);
    three.renderer.xr.addEventListener('sessionend', onARSessionEnd);
    cleanups.push(() => {
      three.renderer.xr.removeEventListener('sessionstart', onARSessionStart);
      three.renderer.xr.removeEventListener('sessionend', onARSessionEnd);
    });
  }

  // Track anchor creation state (outside AR block so render loop can access)
  let anchorsCreated = false;

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

  // Gun is attached to camera with fixed position/rotation
  // Adjust rotation in loadRifleModel options to align with center of view
  const aimRifle = () => {
    // No-op: gun rotation is fixed relative to camera
  };

  three.onRender((time, frame) => {
    const deltaSec = prevTime ? (time - prevTime) / 1000 : 0;
    prevTime = time;

    // In calibration mode, update calibration instead of normal pointer movement
    if (frame && imageCalibration?.isActive()) {
      imageCalibration.update(frame, deltaSec);
    } else if (frame && calibrationMode?.isActive()) {
      calibrationMode.update(frame, deltaSec);
    } else {
      updatePointerFromXR(frame, deltaSec);
      updatePointerFromKeyboard(deltaSec);
      aimRifle();
    }

    reticleObj.update(three.camera, pointer.value.x, pointer.value.y, deltaSec);
    shotEffect.update();
    destructionEffect.update();

    // Update score display position to follow camera
    const xrCamera = three.renderer.xr.isPresenting ? three.renderer.xr.getCamera() : three.camera;
    scoreDisplay.update(xrCamera);

    // Update game UI (capture/loading screens)
    gameUI.update(xrCamera, deltaSec);

    // Update hint arrow (only during playing phase)
    if (gamePhase.value.phase === 'playing' && segmentationInit?.isReady()) {
      const masks = segmentationInit.getMaskOverlay()?.getMasks() ?? [];
      hintArrow.update(xrCamera, masks, deltaSec);
    } else {
      hintArrow.arrow.visible = false;
    }

    // Create anchors once after calibration is complete (not during calibration)
    if (frame && !anchorsCreated && segmentationInit?.isReady() && calibrationCompleted) {
      anchorsCreated = true;
      segmentationInit.createAnchors(frame);
    }

    // Update segmentation mask anchors (only after calibration)
    if (frame && segmentationInit?.isReady() && calibrationCompleted) {
      segmentationInit.update(frame);
    }

    // Update room mesh from WebXR mesh detection
    if (frame && roomMesh) {
      const referenceSpace = three.renderer.xr.getReferenceSpace();
      if (referenceSpace) {
        roomMesh.update(frame, referenceSpace);
      }
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
