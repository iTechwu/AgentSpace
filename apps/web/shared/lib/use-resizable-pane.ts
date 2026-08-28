import { useCallback, useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

interface UseResizablePaneOptions {
  cssVariableName?: string;
  defaultWidth: number;
  maxWidth: number;
  minWidth: number;
  storageKey: string;
}

interface UseResizablePaneResult {
  maxWidth: number;
  minWidth: number;
  paneStyle: CSSProperties;
  width: number;
  onHandleKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
}

function clampWidth(value: number, minWidth: number, maxWidth: number): number {
  return Math.min(maxWidth, Math.max(minWidth, Math.round(value)));
}

export function useResizablePane({
  cssVariableName = "--conversation-list-width",
  defaultWidth,
  maxWidth,
  minWidth,
  storageKey,
}: UseResizablePaneOptions): UseResizablePaneResult {
  const [width, setWidth] = useState(defaultWidth);
  const [hasLoadedStoredWidth, setHasLoadedStoredWidth] = useState(false);

  useEffect(() => {
    try {
      const storedValue = window.localStorage.getItem(storageKey);
      const storedWidth = storedValue ? Number.parseInt(storedValue, 10) : Number.NaN;
      if (Number.isFinite(storedWidth)) {
        setWidth(clampWidth(storedWidth, minWidth, maxWidth));
      }
    } catch {
      // Ignore storage failures; resizing should still work for the current session.
    }
    setHasLoadedStoredWidth(true);
  }, [maxWidth, minWidth, storageKey]);

  useEffect(() => {
    if (!hasLoadedStoredWidth) {
      return;
    }

    try {
      window.localStorage.setItem(storageKey, String(width));
    } catch {
      // Ignore storage failures; the visual width has already been updated.
    }
  }, [hasLoadedStoredWidth, storageKey, width]);

  const onHandlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    function handlePointerMove(moveEvent: PointerEvent): void {
      setWidth(clampWidth(startWidth + moveEvent.clientX - startX, minWidth, maxWidth));
    }

    function handlePointerUp(): void {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    }

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp, { once: true });
  }, [maxWidth, minWidth, width]);

  const onHandleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const step = event.shiftKey ? 40 : 16;
    setWidth((currentWidth) => clampWidth(currentWidth + direction * step, minWidth, maxWidth));
  }, [maxWidth, minWidth]);

  const paneStyle = useMemo(() => ({
    [cssVariableName]: `${width}px`,
  }) as CSSProperties, [cssVariableName, width]);

  return {
    maxWidth,
    minWidth,
    paneStyle,
    width,
    onHandleKeyDown,
    onHandlePointerDown,
  };
}
