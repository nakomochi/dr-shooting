/** Quest 3 の入力（select/squeeze）とデスクトップフォールバックをまとめたハンドラ */
export type Quest3InputHandler = {
  attachXR: (session: XRSession) => void;
  attachFallback: (target?: EventTarget) => void;
  detach: () => void;
};

/**
 * XR セッション開始時は XR イベントを購読し、非 XR 環境では pointer / key を購読する。
 * onInput で任意の処理を受け取り、デフォルトでは console.log にも出力する。
 */
export const createQuest3InputHandler = (
  onInput?: (event: Event) => void
): Quest3InputHandler => {
  let xrCleanup: (() => void) | null = null;
  let fallbackCleanup: (() => void) | null = null;

  const logInput = (event: Event) => {
    // For now, just surface the event and basic metadata
    const xrEvent = event as XRInputSourceEvent;
    const info = xrEvent.inputSource
      ? {
          type: event.type,
          handedness: xrEvent.inputSource.handedness,
          targetRayMode: xrEvent.inputSource.targetRayMode,
        }
      : { type: event.type };
    console.log("[Quest3 Input]", info);
    onInput?.(event);
  };

  const attachXR = (session: XRSession) => {
    const handleSelect = (event: XRInputSourceEvent) => logInput(event);
    const handleSqueeze = (event: XRInputSourceEvent) => logInput(event);

    // session.addEventListener("select", handleSelect);
    session.addEventListener("squeezestart", handleSqueeze);
    // session.addEventListener("squeezeend", handleSqueeze);

    xrCleanup = () => {
      // session.removeEventListener("select", handleSelect);
      session.removeEventListener("squeezestart", handleSqueeze);
      // session.removeEventListener("squeezeend", handleSqueeze);
    };
  };

  const attachFallback = (target: EventTarget = window) => {
    const handlePointer = (event: Event) => logInput(event);
    const handleKey = (event: Event) => logInput(event);

    target.addEventListener("pointerdown", handlePointer);
    // target.addEventListener("pointerup", handlePointer);
    // target.addEventListener("keydown", handleKey);

    fallbackCleanup = () => {
      target.removeEventListener("pointerdown", handlePointer);
      // target.removeEventListener("pointerup", handlePointer);
      // target.removeEventListener("keydown", handleKey);
    };
  };

  const detach = () => {
    xrCleanup?.();
    fallbackCleanup?.();
    xrCleanup = null;
    fallbackCleanup = null;
  };

  return { attachXR, attachFallback, detach };
};
