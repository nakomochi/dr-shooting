/** XR の select イベントをフックする簡易ハンドラ */
export type SelectHandler = () => void;

/**
 * XRSession の select イベントを購読し、detach で必ず解除する小さなユーティリティ。
 */
export const createXRSelectHandler = () => {
  let cleanup: (() => void) | null = null;

  const attach = (session: XRSession, onSelect: SelectHandler) => {
    const handleSelect = () => onSelect();
    session.addEventListener("select", handleSelect);
    cleanup = () => session.removeEventListener("select", handleSelect);
  };

  const detach = () => {
    cleanup?.();
    cleanup = null;
  };

  return { attach, detach };
};
