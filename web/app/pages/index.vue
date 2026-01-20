<template>
  <div class="game-container">
    <screen />

    <!-- Start screen (shown before AR mode) -->
    <div v-if="gamePhase.phase === 'idle'" class="start-screen">
      <div class="start-content">
        <h1 class="game-title">DR Shooting</h1>
        <p class="game-subtitle">Diminished Reality</p>

        <p class="start-hint">Press "Start AR" button to begin</p>
      </div>

      <button class="reload-btn" @click="reload">↻ Reload</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useGamePhase } from '~/composables/gamePhase';

const gamePhase = useGamePhase();

const reload = () => {
  window.location.reload();
};
</script>

<style scoped lang="scss">
.game-container {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: #000;
}

.start-screen {
  position: fixed;
  inset: 0;
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f0f23 100%);
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  align-items: center;
  padding-top: 20vh;
  z-index: 200;
}

.start-content {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.game-title {
  font-size: 3.5rem;
  font-weight: bold;
  color: #ff6600;
  margin: 0;
  text-shadow:
    0 0 20px rgba(255, 102, 0, 0.8),
    0 0 40px rgba(255, 102, 0, 0.4);
}

.game-subtitle {
  font-size: 1.25rem;
  color: #666;
  margin: 0;
  letter-spacing: 0.2em;
}

.start-hint {
  margin-top: 2rem;
  color: #888;
  font-size: 1rem;
}

.reload-btn {
  position: absolute;
  bottom: 2rem;
  right: 2rem;
  padding: 0.75rem 1.5rem;
  font-size: 1rem;
  color: #ccc;
  background: rgba(255, 255, 255, 0.1);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    background: rgba(255, 255, 255, 0.2);
    color: #fff;
  }

  &:active {
    transform: scale(0.95);
  }
}
</style>
