import { useState } from "#app";

/** ゲームのフェーズ */
export type GamePhase = 'idle' | 'capture' | 'loading' | 'playing';

/** ゲームフェーズの状態 */
export type GamePhaseState = {
  phase: GamePhase;
  maskCount: number;
  destroyedCount: number;
};

/** ゲームフェーズ状態を取得（なければ初期化） */
export const useGamePhase = () =>
  useState<GamePhaseState>("game-phase", () => ({
    phase: 'idle',
    maskCount: 0,
    destroyedCount: 0,
  }));

/** フェーズを設定 */
export const setGamePhase = (phase: GamePhase) => {
  const state = useGamePhase();
  state.value = { ...state.value, phase };
};

/** スコアを更新 */
export const updateGameScore = (destroyed: number, total: number) => {
  const state = useGamePhase();
  state.value = { ...state.value, destroyedCount: destroyed, maskCount: total };
};

/** フェーズをリセット */
export const resetGamePhase = () => {
  const state = useGamePhase();
  state.value = { phase: 'idle', maskCount: 0, destroyedCount: 0 };
};
