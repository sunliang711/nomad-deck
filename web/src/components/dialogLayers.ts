const layers: HTMLElement[] = [];
let originalOverflow = '';

export interface BackdropPointerEventLike {
  button?: number;
  pointerType?: string;
  target: EventTarget | null;
  currentTarget: EventTarget | null;
}

export interface BackdropClickGuard {
  onPointerDown: (event: BackdropPointerEventLike) => void;
  onPointerUp: (event: BackdropPointerEventLike) => void;
  shouldCloseOnClick: (event: BackdropPointerEventLike, enabled: boolean) => boolean;
  reset: () => void;
}

/**
 * 仅当按压起止都落在遮罩层自身且显式允许点击遮罩关闭时，才允许触发关闭，
 * 避免在弹窗内划选文本拖出边界时误关闭弹窗。
 */
export function createBackdropClickGuard(): BackdropClickGuard {
  let startedOnBackdrop = false;
  let endedOnBackdrop = false;

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
    },
    onPointerUp(event) {
      endedOnBackdrop = isPrimaryBackdropEvent(event);
    },
    shouldCloseOnClick(event, enabled) {
      const shouldClose =
        enabled &&
        startedOnBackdrop &&
        endedOnBackdrop &&
        event.target !== null &&
        event.target === event.currentTarget;
      startedOnBackdrop = false;
      endedOnBackdrop = false;
      return shouldClose;
    },
    reset() {
      startedOnBackdrop = false;
      endedOnBackdrop = false;
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
