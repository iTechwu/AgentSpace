import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoRefresh } from "@/shared/lib/use-auto-refresh";

const routerRefreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: routerRefreshMock,
  }),
}));

function AutoRefreshProbe({
  enabled = true,
  intervalMs = 1000,
  onRefresh,
  allowWhileInputActive = false,
}: {
  enabled?: boolean;
  intervalMs?: number;
  onRefresh?: () => void;
  allowWhileInputActive?: boolean;
}) {
  useAutoRefresh(enabled, intervalMs, onRefresh, { allowWhileInputActive });
  return null;
}

describe("useAutoRefresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    routerRefreshMock.mockReset();
    setDocumentVisibilityState("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    setDocumentVisibilityState("visible");
  });

  it("skips refresh ticks while the document is hidden", () => {
    const onRefresh = vi.fn();
    render(<AutoRefreshProbe onRefresh={onRefresh} />);

    setDocumentVisibilityState("hidden");
    vi.advanceTimersByTime(1000);

    expect(onRefresh).not.toHaveBeenCalled();

    setDocumentVisibilityState("visible");
    vi.advanceTimersByTime(1000);

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("skips refresh ticks while an editable field is focused", () => {
    const onRefresh = vi.fn();
    render(
      <>
        <input aria-label="Draft" />
        <AutoRefreshProbe onRefresh={onRefresh} />
      </>,
    );

    document.querySelector("input")?.focus();
    vi.advanceTimersByTime(1000);

    expect(onRefresh).not.toHaveBeenCalled();

    (document.activeElement as HTMLElement | null)?.blur();
    vi.advanceTimersByTime(1000);

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes a live view while an editable field is focused when explicitly allowed", () => {
    const onRefresh = vi.fn();
    render(
      <>
        <input aria-label="Draft" />
        <AutoRefreshProbe allowWhileInputActive onRefresh={onRefresh} />
      </>,
    );

    document.querySelector("input")?.focus();
    vi.advanceTimersByTime(1000);

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("falls back to router refresh when no module refresh handler is available", () => {
    render(<AutoRefreshProbe />);

    vi.advanceTimersByTime(1000);

    expect(routerRefreshMock).toHaveBeenCalledTimes(1);
  });
});

function setDocumentVisibilityState(value: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}
