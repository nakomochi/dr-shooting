<template>
  <div>
    <canvas ref="canvasRef" class="three-screen"></canvas>
    <div ref="shotCircleRef" class="shot-circle" :style="shotCircleStyle"></div>
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
  sendShotAndApplyBackground,
} from '~/composables/three';
import { usePointerState, nudgePointer } from '~/composables/pointer';
import * as THREE from 'three';
import { computed } from 'vue';

// Three.js が描画するキャンバス参照と、ライフサイクルで実行するクリーンアップ関数群
const canvasRef = ref<HTMLCanvasElement | null>(null);
const shotCircleRef = ref<HTMLDivElement | null>(null);
const cleanups: Array<() => void> = [];
const pointer = usePointerState();
const bgUrlHolder = { current: null as string | null };
const shotCircleStyle = computed(() => {
  const x = pointer.value.x * 45;
  const y = -pointer.value.y * 45;
  return {
    transform: `translate(-50%, -50%) translate(${x}vw, ${y}vh) scale(1)`
  };
});

onMounted(async () => {
  const canvas = canvasRef.value;
  if (!canvas) return;

  // Three.js コアセットアップ（Scene/Camera/Renderer）
  const three = createThreeCore(canvas);
  cleanups.push(three.dispose);

  // リサイズに追従
  const stopResize = attachResizeHandler(three.renderer, three.camera);
  cleanups.push(stopResize);

  // 発砲時の視覚振動 + デバイス振動（共通化）
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

  // 発砲演出: 照準リングを巨大化→瞬時に収束させる
  const shotCircleDuration = 360; // 照準リングの収束時間（ms）

  const playShotCircle = () => {
    const el = shotCircleRef.value;
    if (!el) return;
    const x = pointer.value.x * 45;
    const y = -pointer.value.y * 45;
    const base = `translate(-50%, -50%) translate(${x}vw, ${y}vh)`;
    const animation = el.animate(
      [
        { transform: `${base} scale(8)`, opacity: 1 },
        { transform: `${base} scale(1.05)`, opacity: 0.7 },
        { transform: `${base} scale(0.1)`, opacity: 0 },
      ],
      {
        duration: shotCircleDuration,
        easing: 'cubic-bezier(0.3, 0.8, 0.4, 1)',
      }
    );
    animation.finished.catch(() => { });
  };

  const handleFireWithEffects = async () => {
    handleFire();
    playShotCircle();
    try {
      await sendShotAndApplyBackground({
        canvasRef,
        pointer,
        previousUrl: bgUrlHolder,
      });
    } catch (error) {
      console.error('Failed to send shot data', error);
    }
    console.log('Fired!');
  };

  // キーボード入力でポインタを移動（非 XR 環境など）
  const keyState = new Set<string>();
  const onKeyDown = (e: KeyboardEvent) => keyState.add(e.key.toLowerCase());
  const onKeyUp = (e: KeyboardEvent) => keyState.delete(e.key.toLowerCase());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  cleanups.push(() => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  });

  // ライフル参照を保持して照準方向を更新
  let rifle: THREE.Object3D | null = null;

  // Quest 3 入力（XR/非XR 両対応）。XR セッション開始/終了に合わせて付け替える。
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
  // const useAR = false;

  // 非 AR 時はカメラ映像を背景に敷く
  if (!useAR) {
    try {
      const webcam = await createWebcamBackgroundCover(three.scene, three.camera);
      cleanups.push(webcam.dispose);
    } catch (error) {
      console.error('Failed to init webcam', error);
    }
  }

  try {
    // 銃モデルを読み込み、位置・回転・スケールを指定して配置
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

  // WebXR ボタン設置と有効化
  const xrCleanup = setupXR(three.renderer, useAR ? 'ar' : 'vr');
  cleanups.push(xrCleanup);

  // 毎フレーム、入力からポインタを更新しライフルをポインティング
  let prevTime = 0;
  const pointerSpeed = 1.6; // 単位: 正規化座標/秒（XR 軸・キーボード共通）

  const updatePointerFromXR = (frame?: XRFrame, deltaSec = 0) => {
    const session = frame?.session || three.renderer.xr.getSession();
    if (!session) return;
    for (const source of session.inputSources) {
      const axes = source.gamepad?.axes;
      if (!axes || axes.length < 2) continue;
      const dx = axes[0]! * pointerSpeed * deltaSec;
      const dy = -axes[1]! * pointerSpeed * deltaSec;
      nudgePointer(dx, dy);
      return; // 1 つ目の入力のみ採用
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
  });

  three.start();
});

onBeforeUnmount(() => {
  // 登録済みクリーンアップを逆順で実行
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

.shot-circle {
  position: fixed;
  top: 50%;
  left: 50%;
  width: 15rem;
  height: 15rem;
  transform: translate(-50%, -50%) scale(1);
  background-color: rgba(255, 255, 255, 0.8);
  border-radius: 50%;
  pointer-events: none;
  opacity: 0;
  will-change: transform, opacity;
  z-index: 10000;
}
</style>