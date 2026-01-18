/**
 * 発砲時のフィードバック（画面シェイク + ハプティクス）をまとめたユーティリティ。
 * getXRSession で XRSession を取得できるようにしておくと、対応デバイスではコントローラ振動も鳴らす。
 */
export type FireFeedbackOptions = {
  /** キャンバスを揺らす強さ（ピクセル） */
  shakeIntensity?: number;
  /** キャンバスの揺れ時間（ms） */
  shakeDuration?: number;
  /** ハプティクスを鳴らす時間（ms） */
  hapticDuration?: number;
  /** ハプティクス強度（0.0-1.0） */
  hapticStrength?: number;
};

export type FireFeedbackParams = {
  /** 揺らす対象のキャンバス要素 Ref */
  canvasRef: { value: HTMLCanvasElement | null };
  /** XRSession を取得する関数（非 XR 環境では null を返す） */
  getXRSession: () => XRSession | null;
  /** 振動や強度のオプション */
  options?: FireFeedbackOptions;
};

/**
 * 発砲ハンドラを生成して返す。返却された fire() を呼ぶだけでシェイク + ハプティクスが走る。
 */
export const createFireFeedback = ({
  canvasRef, getXRSession, options,
}: FireFeedbackParams) => {
  const shakeIntensity = options?.shakeIntensity ?? 8;
  const shakeDuration = options?.shakeDuration ?? 140;
  const hapticDuration = options?.hapticDuration ?? 60;
  const hapticStrength = options?.hapticStrength ?? 0.6;

  const shakeCanvas = () => {
    const canvas = canvasRef.value;
    if (!canvas) return;
    canvas.animate(
      [
        { transform: "translate(0px, 0px)" },
        { transform: `translate(${shakeIntensity}px, ${-shakeIntensity}px) scale(1.2)` },
        { transform: `translate(${-shakeIntensity}px, ${shakeIntensity}px) scale(0.8)` },
        { transform: `translate(${shakeIntensity}px, ${-shakeIntensity}px) scale(1.2)` },
        { transform: `translate(${-shakeIntensity}px, ${shakeIntensity}px) scale(0.8)` },
        { transform: "translate(0px, 0px)" },
      ],
      { duration: shakeDuration, easing: "ease-in-out" }
    );
  };

  const hapticPulse = () => {
    const session = getXRSession();
    let delivered = false;

    if (session) {
      for (const source of session.inputSources) {
        const actuators = source.gamepad?.hapticActuators || [];
        if (actuators.length > 0 && actuators[0]?.pulse) {
          actuators[0].pulse(hapticStrength, hapticDuration);
          delivered = true;
        }
      }
    }

    if (!delivered && navigator.vibrate) {
      navigator.vibrate(hapticDuration);
    }
  };

  /** 発砲をトリガーし、シェイクとハプティクスを実行 */
  const fire = () => {
    shakeCanvas();
    hapticPulse();
  };

  return { fire };
};
