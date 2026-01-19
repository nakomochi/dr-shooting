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

  // Room mesh manager (AR mode only) - displays Quest3 scanned mesh
  let roomMesh: ReturnType<typeof createRoomMesh> | null = null;

  // Calibration mode (AR mode only) - for adjusting mask positions
  let calibrationMode: ReturnType<typeof createCalibrationMode> | null = null;
  let calibrationCompleted = false;

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
    // In calibration mode, trigger confirms current mask position
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

    // Calibration parameters (from calibration results)
    const CALIBRATION_SCALE_FACTOR = 0.46;
    const CALIBRATION_OFFSET_X = -0.16;
    const CALIBRATION_OFFSET_Y = 0.01;
    const IS_CALIBRATION_MODE = false;

    segmentationInit = createSegmentationInit({
      scene: three.scene,
      camera: three.camera,
      renderer: three.renderer,
      maskOpacity: 0.4,
      maskDistance: 2.5,
      cameraFov: 97,
      scaleFactor: IS_CALIBRATION_MODE ? 1.0 : CALIBRATION_SCALE_FACTOR,
      offsetX: IS_CALIBRATION_MODE ? 0 : CALIBRATION_OFFSET_X,
      offsetY: IS_CALIBRATION_MODE ? 0 : CALIBRATION_OFFSET_Y,
      useMeshPositioning: false,
    });
    cleanups.push(() => segmentationInit?.dispose());

    // Initialize segmentation and room mesh when XR session starts
    let segmentationInitialized = false;

    const initSegmentation = async () => {
      const session = three.renderer.xr.getSession();
      if (!session || segmentationInitialized) return;

      // Start room mesh detection
      if (roomMesh) {
        const meshSupported = await roomMesh.start(session);
        console.log('[Screen] Room mesh detection supported:', meshSupported);
      }

      // Wait for mesh detection to provide some data
      // We'll poll for mesh availability with timeout
      const MESH_WAIT_TIMEOUT = 3000; // 3 seconds max wait
      const MESH_CHECK_INTERVAL = 100; // Check every 100ms
      const startTime = Date.now();

      const waitForMesh = (): Promise<boolean> => {
        return new Promise((resolve) => {
          const checkMesh = () => {
            const meshes = roomMesh?.getMeshes() ?? [];
            if (meshes.length > 0) {
              console.log(`[Screen] Mesh detected: ${meshes.length} meshes available`);
              resolve(true);
              return;
            }
            if (Date.now() - startTime > MESH_WAIT_TIMEOUT) {
              console.warn('[Screen] Mesh detection timeout, proceeding without mesh');
              resolve(false);
              return;
            }
            setTimeout(checkMesh, MESH_CHECK_INTERVAL);
          };
          checkMesh();
        });
      };

      // Wait for first frame to get XRFrame
      session.requestAnimationFrame(async (_time, frame) => {
        if (!segmentationInitialized && frame && segmentationInit) {
          segmentationInitialized = true;

          // Wait for mesh to be available (with timeout)
          await waitForMesh();

          // Now initialize segmentation (will use mesh for positioning if available)
          await segmentationInit.initialize(frame);

          // Update total count after segmentation is ready
          totalCount = segmentationInit.getMaskOverlay()?.getMaskCount() ?? 0;
          scoreDisplay.updateScore(destroyedCount, totalCount);

          // Start calibration mode after segmentation is ready (only in calibration mode)
          if (IS_CALIBRATION_MODE) {
            const maskOverlay = segmentationInit.getMaskOverlay();
            const imageSize = segmentationInit.getImageSize();
            if (maskOverlay && imageSize && maskOverlay.getMaskCount() > 0) {
              calibrationMode = createCalibrationMode({
                maskOverlay,
                camera: three.camera,
                renderer: three.renderer,
                imageSize,
                cameraFov: 97,
                maxCalibrationCount: 5,
                onComplete: (params, samples) => {
                  console.log('[Screen] Calibration complete!');
                  console.log('[Screen] Parameters:', params);
                  console.log('[Screen] Samples:', samples.length);
                  calibrationCompleted = true;
                },
              });
              calibrationMode.start();
              cleanups.push(() => calibrationMode?.dispose());
            }
          } else {
            calibrationCompleted = true;
          }
        }
      });
    };

    three.renderer.xr.addEventListener('sessionstart', initSegmentation);
    cleanups.push(() => {
      three.renderer.xr.removeEventListener('sessionstart', initSegmentation);
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

    // In calibration mode, update calibration instead of normal pointer movement
    if (frame && calibrationMode?.isActive()) {
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
