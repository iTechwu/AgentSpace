"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const NON_EDITABLE_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export function isDocumentInputActive(doc?: Document): boolean {
  const currentDocument = doc ?? (typeof document === "undefined" ? null : document);
  if (!currentDocument) {
    return false;
  }

  return isEditableElement(currentDocument.activeElement);
}

function isEditableElement(element: Element | null): boolean {
  if (!element) {
    return false;
  }

  const view = element.ownerDocument.defaultView;
  if (!view || !(element instanceof view.HTMLElement)) {
    return false;
  }

  if (element.isContentEditable) {
    return true;
  }

  if (element instanceof view.HTMLTextAreaElement) {
    return !element.disabled && !element.readOnly;
  }

  if (element instanceof view.HTMLSelectElement) {
    return !element.disabled;
  }

  if (element instanceof view.HTMLInputElement) {
    return !element.disabled && !element.readOnly && !NON_EDITABLE_INPUT_TYPES.has(element.type);
  }

  return false;
}

export function useAutoRefresh(
  enabled: boolean,
  intervalMs: number,
  onRefresh?: () => void,
  options?: { allowWhileInputActive?: boolean },
): void {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") {
        return;
      }
      if (!options?.allowWhileInputActive && isDocumentInputActive()) {
        return;
      }
      if (onRefresh) {
        onRefresh();
        return;
      }
      router.refresh();
    }, intervalMs);

    return () => window.clearInterval(timer);
  }, [enabled, intervalMs, onRefresh, options?.allowWhileInputActive, router]);
}
