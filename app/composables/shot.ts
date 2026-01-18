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

/**
 * XR 側キャンバス（なければメイン）をキャプチャし、ポインタ座標とともに送信。
 * レスポンス画像を canvas 背景に適用し、必要なら既存 ObjectURL を解放する。
 */
export const sendShotAndApplyBackground = async (
  opts: ShotSendOptions
): Promise<string | null> => {
  const endpoint = opts.endpoint ?? "https://example.com/api/shots";
  const targetCanvas = findTargetCanvas(opts.canvasRef.value);

  const blob = targetCanvas ? await canvasToBlob(targetCanvas) : null;

  const form = new FormData();
  form.append("x", opts.pointer.value.x.toString());
  form.append("y", opts.pointer.value.y.toString());
  if (blob) form.append("image", blob, "shot.png");

  const res = await fetch(endpoint, { method: "POST", body: form });
  if (!res.ok) throw new Error(`Status ${res.status}`);

  const editedBlob = await res.blob();
  const url = URL.createObjectURL(editedBlob);

  if (opts.previousUrl?.current) URL.revokeObjectURL(opts.previousUrl.current);
  if (opts.previousUrl) opts.previousUrl.current = url;

  const canvasEl = opts.canvasRef.value;
  if (canvasEl) {
    canvasEl.style.backgroundImage = `url(${url})`;
    canvasEl.style.backgroundSize = "cover";
    canvasEl.style.backgroundPosition = "center";
  }

  return url;
};
