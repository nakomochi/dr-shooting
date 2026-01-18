import { useState } from "#app";

/** 画面上のポインタ位置を -1..1 の正規化座標で保持するグローバルステート */
export type PointerState = {
  x: number;
  y: number;
};

const clamp = (v: number, min = -1, max = 1) => Math.min(max, Math.max(min, v));

/** ポインタ状態を取得（なければ初期化） */
export const usePointerState = () =>
  useState<PointerState>("pointer-state", () => ({ x: 0, y: 0 }));

/** 絶対値で座標を設定 */
export const setPointer = (x: number, y: number) => {
  const state = usePointerState();
  state.value = { x: clamp(x), y: clamp(y) };
};

/** 相対移動で座標を更新 */
export const nudgePointer = (dx: number, dy: number) => {
  const state = usePointerState();
  state.value = {
    x: clamp(state.value.x + dx),
    y: clamp(state.value.y + dy),
  };
};
