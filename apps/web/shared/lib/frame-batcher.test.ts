import { describe, expect, it, vi } from "vitest";
import { createFrameBatcher } from "@/shared/lib/frame-batcher";

describe("createFrameBatcher", () => {
  it("flushes all visible updates once in the next frame", () => {
    const flush = vi.fn();
    let callback: FrameRequestCallback | undefined;
    const batcher = createFrameBatcher<number>({
      flush,
      isHidden: () => false,
      requestFrame: (next) => { callback = next; return 1; },
      cancelFrame: vi.fn(),
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    });

    batcher.enqueue(1);
    batcher.enqueue(2);

    expect(flush).not.toHaveBeenCalled();
    callback?.(16);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith([1, 2]);
  });

  it("uses one background timer and flushes immediately when visible again", () => {
    let hidden = true;
    const flush = vi.fn();
    let timer: (() => void) | undefined;
    const batcher = createFrameBatcher<number>({
      flush,
      isHidden: () => hidden,
      requestFrame: vi.fn(() => 1),
      cancelFrame: vi.fn(),
      setTimer: (next) => { timer = next; return 2; },
      clearTimer: vi.fn(),
    });

    batcher.enqueue(1);
    batcher.enqueue(2);
    expect(timer).toBeDefined();

    hidden = false;
    batcher.notifyVisibilityChanged();
    expect(flush).toHaveBeenCalledWith([1, 2]);
  });

  it("cancels queued work on dispose", () => {
    const flush = vi.fn();
    let callback: FrameRequestCallback | undefined;
    const cancelFrame = vi.fn();
    const batcher = createFrameBatcher<number>({
      flush,
      isHidden: () => false,
      requestFrame: (next) => { callback = next; return 7; },
      cancelFrame,
      setTimer: vi.fn(),
      clearTimer: vi.fn(),
    });

    batcher.enqueue(1);
    batcher.dispose();
    callback?.(16);
    batcher.enqueue(2);

    expect(cancelFrame).toHaveBeenCalledWith(7);
    expect(flush).not.toHaveBeenCalled();
  });
});
