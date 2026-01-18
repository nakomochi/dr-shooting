<template>
  <div class="overlay">
    <div class="cutout">
      <div class="cutout-inner" :style="cutoutStyle">
        <div class="icon">
          <UiCenter />
        </div>

        <div v-for="n in 3" :key="n" class="circles"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { usePointerState } from '~/composables/pointer';

const pointer = usePointerState();

// 画面正規化座標 (-1..1) をビューポート移動に変換
const cutoutStyle = computed(() => {
  const x = pointer.value.x * 45; // vw 換算で移動量を控えめに
  const y = -pointer.value.y * 45; // 画面上方向を正にするため符号反転
  return {
    transform: `translate(${x}vw, ${y}vh)`
  };
});
</script>

<style scoped lang="scss">
.overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 10000;
}

.cutout {
  position: relative;
  width: 90%;
  height: 90%;
  border-radius: 40px;
  box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.4);
  display: flex;
  justify-content: center;
  align-items: center;
  transition: transform 0.08s ease-out;
}

.cutout-inner {
  position: relative;
  width: 10rem;
  aspect-ratio: 1 / 1;
  display: flex;
  justify-content: center;
  align-items: center;
}

/* 縦の点線 */
.cutout-inner::before {
  content: "";
  position: absolute;
  top: 0;
  left: 50%;
  width: 0;
  height: 100%;
  border-left: 2px dashed rgba(255, 255, 255, 0.5);
  transform: translateX(-50%);
}

/* 横の点線 */
.cutout-inner::after {
  content: "";
  position: absolute;
  left: 0;
  top: 50%;
  width: 100%;
  height: 0;
  border-top: 2px dashed rgba(255, 255, 255, 0.5);
  transform: translateY(-50%);
}

.icon {
  width: 48px;
  height: 48px;
  color: rgb(255, 0, 0);
  z-index: 1;
}

.circles {
  position: absolute;
  aspect-ratio: 2 / 1;
  background: transparent;
  border: 4px solid;
  border-radius: 50% / 100% 100% 0 0;
  border-bottom: none;
  transform-origin: 50% 100%;
  transform: translateY(-50%);
  animation: spin 2s linear infinite;
}

/* 個別調整 */
.circles:nth-child(2) {
  width: 10rem;
  animation-duration: 3s;
  animation-direction: reverse;
  border-color: #ffffff80
}

.circles:nth-child(3) {
  width: 12rem;
  animation-duration: 1.5s;
  border-color: #ffffff80;
}

.circles:nth-child(4) {
  width: 14rem;
  animation-duration: 4s;
  animation-direction: reverse;
  border-color: #ffffff80;
}

@keyframes spin {
  from {
    transform: translateY(-50%) rotate(0deg);
  }

  to {
    transform: translateY(-50%) rotate(360deg);
  }
}
</style>