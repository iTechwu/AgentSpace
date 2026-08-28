import type { KeyboardEvent, PointerEvent } from "react";

interface PaneResizeHandleProps {
  label: string;
  maxValue?: number;
  minValue?: number;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  value: number;
}

export function PaneResizeHandle({
  label,
  maxValue = 560,
  minValue = 300,
  onKeyDown,
  onPointerDown,
  value,
}: PaneResizeHandleProps) {
  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={maxValue}
      aria-valuemin={minValue}
      aria-valuenow={value}
      className="conversation-resize-handle"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      role="separator"
      tabIndex={0}
    />
  );
}
