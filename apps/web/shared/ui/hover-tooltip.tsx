"use client";

import type { CSSProperties, FocusEvent, ReactNode } from "react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface HoverTooltipProps {
  readonly align?: "center" | "end";
  readonly content: string;
  readonly children: (props: {
    describedBy: string;
    expanded: boolean;
    onToggle: () => void;
  }) => ReactNode;
}

interface TooltipPosition {
  readonly left: number;
  readonly top: number;
  readonly arrowLeft: number;
  readonly placement: "top" | "bottom";
}

const TOOLTIP_GAP_PX = 10;
const TOOLTIP_VIEWPORT_PADDING_PX = 16;
const TOOLTIP_ARROW_INSET_PX = 16;

export function HoverTooltip({ align = "end", content, children }: HoverTooltipProps) {
  const tooltipId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const [isMounted, setIsMounted] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);

  const updatePosition = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    const anchor = anchorRef.current;
    const tooltip = tooltipRef.current;
    if (!anchor || !tooltip) {
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const maxLeft = Math.max(
      TOOLTIP_VIEWPORT_PADDING_PX,
      viewportWidth - TOOLTIP_VIEWPORT_PADDING_PX - tooltipRect.width,
    );
    const idealLeft = align === "center"
      ? anchorRect.left + (anchorRect.width / 2) - (tooltipRect.width / 2)
      : anchorRect.right - tooltipRect.width;
    const left = Math.min(Math.max(idealLeft, TOOLTIP_VIEWPORT_PADDING_PX), maxLeft);
    const spaceBelow = viewportHeight - anchorRect.bottom - TOOLTIP_VIEWPORT_PADDING_PX;
    const spaceAbove = anchorRect.top - TOOLTIP_VIEWPORT_PADDING_PX;
    const placeAbove = spaceBelow < tooltipRect.height + TOOLTIP_GAP_PX && spaceAbove > spaceBelow;
    const top = placeAbove
      ? Math.max(
          TOOLTIP_VIEWPORT_PADDING_PX,
          anchorRect.top - tooltipRect.height - TOOLTIP_GAP_PX,
        )
      : Math.min(
          viewportHeight - TOOLTIP_VIEWPORT_PADDING_PX - tooltipRect.height,
          anchorRect.bottom + TOOLTIP_GAP_PX,
        );
    const anchorCenter = anchorRect.left + (anchorRect.width / 2);
    const arrowLeft = Math.min(
      Math.max(anchorCenter - left, TOOLTIP_ARROW_INSET_PX),
      tooltipRect.width - TOOLTIP_ARROW_INSET_PX,
    );

    setPosition({
      left,
      top,
      arrowLeft,
      placement: placeAbove ? "top" : "bottom",
    });
  }, [align]);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useLayoutEffect(() => {
    if (!isOpen || !isMounted) {
      return;
    }

    updatePosition();
  }, [isMounted, isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen || typeof window === "undefined") {
      return;
    }

    const handleReposition = (): void => updatePosition();
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
    };
  }, [isOpen, updatePosition]);

  function handleBlur(event: FocusEvent<HTMLSpanElement>): void {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setIsOpen(false);
      setIsPinned(false);
    }
  }

  function handleToggle(): void {
    setIsPinned((current) => {
      const next = !current;
      setIsOpen(next);
      return next;
    });
  }

  const tooltipStyle: CSSProperties | undefined = position
    ? {
        left: `${position.left}px`,
        top: `${position.top}px`,
        ["--hover-tooltip-arrow-left" as keyof CSSProperties]: `${position.arrowLeft}px`,
      }
    : undefined;

  return (
    <span
      className={`hover-tooltip${align === "center" ? " hover-tooltip--center" : ""}`}
      onBlur={handleBlur}
      onFocus={() => setIsOpen(true)}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => {
        if (!isPinned) {
          setIsOpen(false);
        }
      }}
      ref={anchorRef}
    >
      {children({ describedBy: tooltipId, expanded: isOpen, onToggle: handleToggle })}
      {isMounted && isOpen
        ? createPortal(
            <span
              className={`hover-tooltip__content hover-tooltip__content--portal${
                position?.placement === "top" ? " hover-tooltip__content--top" : ""
              }`}
              id={tooltipId}
              ref={tooltipRef}
              role="tooltip"
              style={tooltipStyle}
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
