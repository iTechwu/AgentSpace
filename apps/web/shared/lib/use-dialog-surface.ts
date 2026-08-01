"use client";

import type { MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useId, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export function useDialogSurface<T extends HTMLElement>(onClose: () => void) {
  const surfaceRef = useRef<T | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const labelId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const active = document.activeElement;
    previouslyFocusedRef.current = active instanceof HTMLElement ? active : null;
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const activeElement = document.activeElement;
      if (activeElement instanceof HTMLElement && surface.contains(activeElement)) {
        return;
      }
      const autoFocusTarget = surface.querySelector<HTMLElement>("[autofocus]");
      const firstFocusable = getFocusableElements(surface)[0];
      (autoFocusTarget ?? firstFocusable ?? surface).focus();
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    return () => {
      const previous = previouslyFocusedRef.current;
      if (!previous) {
        return;
      }
      if (document.contains(previous)) {
        previous.focus();
      }
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      const surface = surfaceRef.current;
      if (!surface) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusable = getFocusableElements(surface);
      if (focusable.length === 0) {
        event.preventDefault();
        surface.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (!active || !surface.contains(active)) {
        event.preventDefault();
        first?.focus();
        return;
      }

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last?.focus();
        return;
      }

      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function handleBackdropMouseDown(event: ReactMouseEvent<HTMLElement>): void {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  return {
    descriptionId,
    surfaceRef,
    handleBackdropMouseDown,
    labelId,
  };
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("disabled") && element.tabIndex !== -1,
  );
}
