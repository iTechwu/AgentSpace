interface FrameBatcherOptions<T> {
  readonly flush: (items: readonly T[]) => void;
  readonly isHidden: () => boolean;
  readonly requestFrame: (callback: FrameRequestCallback) => number;
  readonly cancelFrame: (id: number) => void;
  readonly setTimer: (callback: () => void, delay: number) => number;
  readonly clearTimer: (id: number) => void;
  readonly backgroundDelayMs?: number;
}

export interface FrameBatcher<T> {
  readonly enqueue: (item: T) => void;
  readonly notifyVisibilityChanged: () => void;
  readonly dispose: () => void;
}

export function createFrameBatcher<T>(options: FrameBatcherOptions<T>): FrameBatcher<T> {
  const queue: T[] = [];
  let frameId: number | null = null;
  let timerId: number | null = null;
  let disposed = false;

  const flush = (): void => {
    frameId = null;
    timerId = null;
    if (disposed || queue.length === 0) {
      return;
    }
    options.flush(queue.splice(0));
  };

  const schedule = (): void => {
    if (disposed || frameId !== null || timerId !== null) {
      return;
    }
    if (options.isHidden()) {
      timerId = options.setTimer(flush, options.backgroundDelayMs ?? 250);
      return;
    }
    frameId = options.requestFrame(flush);
  };

  return {
    enqueue(item) {
      if (disposed) {
        return;
      }
      queue.push(item);
      schedule();
    },
    notifyVisibilityChanged() {
      if (disposed || options.isHidden() || queue.length === 0) {
        return;
      }
      if (timerId !== null) {
        options.clearTimer(timerId);
      }
      if (frameId !== null) {
        options.cancelFrame(frameId);
      }
      timerId = null;
      frameId = null;
      flush();
    },
    dispose() {
      disposed = true;
      if (frameId !== null) {
        options.cancelFrame(frameId);
      }
      if (timerId !== null) {
        options.clearTimer(timerId);
      }
      frameId = null;
      timerId = null;
      queue.length = 0;
    },
  };
}
