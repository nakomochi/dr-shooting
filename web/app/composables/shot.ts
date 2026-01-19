import type { Ref } from "vue";
import type { PointerState } from "./pointer";

/** shot の送信に使うオプション */
export type ShotSendOptions = {
  canvasRef: Ref<HTMLCanvasElement | null>;
  pointer: Ref<PointerState>;
  endpoint?: string;
  /** 既存の ObjectURL を持ち回る場合に指定 */
  previousUrl?: { current: string | null };
};

const findTargetCanvas = (mainCanvas: HTMLCanvasElement | null) => {
  const canvases = Array.from(document.querySelectorAll("canvas"));
  return (
    canvases.find(
      (c) => !c.classList.contains("three-screen") && c !== mainCanvas
    ) ||
    mainCanvas ||
    null
  );
};

const canvasToBlob = (canvas: HTMLCanvasElement): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
