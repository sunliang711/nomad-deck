const layers: HTMLElement[] = [];
let originalOverflow = '';

export interface BackdropPointerEventLike {
  button?: number;
  detail?: number;
  pointerType?: string;
  target: EventTarget | null;
  currentTarget: EventTarget | null;
}

export interface BackdropClickGuard {
  onPointerDown: (event: BackdropPointerEventLike) => void;
  onPointerUp: (event: BackdropPointerEventLike) => void;
  shouldCloseOnClick: (event: BackdropPointerEventLike, enabled: boolean) => boolean;
  shouldCloseOnDoubleClick: (event: BackdropPointerEventLike, enabled: boolean) => boolean;
  reset: () => void;
}

/**
 * 仅当按压起止都落在遮罩层自身时才视为有效遮罩点击，
 * 避免在弹窗内划选文本拖出边界时误关闭弹窗；
 * 同时支持显式单击关闭或连续两次有效遮罩点击后的双击关闭。
 */
export function createBackdropClickGuard(): BackdropClickGuard {
  let startedOnBackdrop = false;
  let endedOnBackdrop = false;
  let consecutiveBackdropClicks = 0;

  const isPrimaryBackdropEvent = (event: BackdropPointerEventLike) => {
    const isPrimaryButton =
      event.button === undefined ||
      event.button === 0 ||
      (event.pointerType !== undefined && event.pointerType !== 'mouse');
    return isPrimaryButton && event.target !== null && event.target === event.currentTarget;
  };

  return {
    onPointerDown(event) {
      startedOnBackdrop = isPrimaryBackdropEvent(event);
      endedOnBackdrop = false;
      if (!startedOnBackdrop) {
        consecutiveBackdropClicks = 0;
      }
    },
    onPointerUp(event) {
      endedOnBackdrop = isPrimaryBackdropEvent(event);
      if (!endedOnBackdrop) {
        consecutiveBackdropClicks = 0;
      }
    },
    shouldCloseOnClick(event, enabled) {
      const cleanBackdropClick =
        startedOnBackdrop &&
        endedOnBackdrop &&
        event.target !== null &&
        event.target === event.currentTarget;
      startedOnBackdrop = false;
      endedOnBackdrop = false;

      if (cleanBackdropClick) {
        if (event.detail === 1) {
          consecutiveBackdropClicks = 1;
        } else {
          consecutiveBackdropClicks += 1;
        }
      } else {
        consecutiveBackdropClicks = 0;
      }

      if (enabled && cleanBackdropClick) {
        consecutiveBackdropClicks = 0;
        return true;
      }
      return false;
    },
    shouldCloseOnDoubleClick(event, enabled) {
      const shouldClose =
        enabled &&
        consecutiveBackdropClicks >= 2 &&
        event.target !== null &&
        event.target === event.currentTarget;
      consecutiveBackdropClicks = 0;
      startedOnBackdrop = false;
      endedOnBackdrop = false;
      return shouldClose;
    },
    reset() {
      startedOnBackdrop = false;
      endedOnBackdrop = false;
      consecutiveBackdropClicks = 0;
    },
  };
}

export function isTopDialog(root: HTMLElement | null): boolean {
  return layers[layers.length - 1] === root;
}

export function registerDialog(root: HTMLElement): () => void {
  const previous = document.activeElement as HTMLElement | null;
  if (layers.length === 0) {
    originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  layers.push(root);
  // 叠加确认框时，底层弹窗暂停接收焦点和键盘事件。
  layers.forEach((layer) => {
    layer.inert = layer !== root;
  });

  return () => {
    const index = layers.indexOf(root);
    if (index >= 0) layers.splice(index, 1);
    root.inert = false;
    const top = layers[layers.length - 1];
    layers.forEach((layer) => {
      layer.inert = layer !== top;
    });
    // 弹窗和确认框可能同时卸载，最后一层关闭后再恢复页面滚动。
    if (!top) document.body.style.overflow = originalOverflow;
    if (previous?.isConnected && (!top || top.contains(previous))) previous.focus();
    else if (top && !top.contains(document.activeElement)) top.focus();
  };
}
