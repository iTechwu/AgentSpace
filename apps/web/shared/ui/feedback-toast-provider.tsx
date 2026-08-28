"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ResolvedToastInput } from "@/shared/lib/toast-action";
import { FeedbackToast } from "@/shared/ui/feedback-toast";

export type ToastInput = ResolvedToastInput;

interface ToastRecord extends ToastInput {
  readonly id: string;
  readonly phase: "visible" | "closing";
}

interface FeedbackToastContextValue {
  readonly pushToast: (toast: ToastInput) => string;
  readonly dismissToast: (id: string) => void;
}

const FeedbackToastContext = createContext<FeedbackToastContextValue | null>(null);

export function FeedbackToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const dismissTimeoutIdsRef = useRef(new Map<string, number>());
  const removalTimeoutIdsRef = useRef(new Map<string, number>());

  const dismissToast = useCallback((id: string) => {
    const timeoutId = dismissTimeoutIdsRef.current.get(id);
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      dismissTimeoutIdsRef.current.delete(id);
    }

    setToasts((current) => current.map((toast) => (
      toast.id === id ? { ...toast, phase: "closing" } : toast
    )));

    const removalTimeoutId = window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
      removalTimeoutIdsRef.current.delete(id);
    }, 220);
    removalTimeoutIdsRef.current.set(id, removalTimeoutId);
  }, []);

  const pushToast = useCallback((toast: ToastInput) => {
    const id = `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const nextToast: ToastRecord = {
      ...toast,
      id,
      phase: "visible",
    };
    setToasts((current) => [...current, nextToast]);

    const timeoutId = window.setTimeout(() => {
      dismissToast(id);
    }, toast.durationMs ?? 3600);
    dismissTimeoutIdsRef.current.set(id, timeoutId);

    return id;
  }, [dismissToast]);

  useEffect(() => {
    return () => {
      for (const timeoutId of dismissTimeoutIdsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      dismissTimeoutIdsRef.current.clear();
      for (const timeoutId of removalTimeoutIdsRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      removalTimeoutIdsRef.current.clear();
    };
  }, []);

  const value = useMemo<FeedbackToastContextValue>(() => ({
    pushToast,
    dismissToast,
  }), [dismissToast, pushToast]);

  return (
    <FeedbackToastContext.Provider value={value}>
      {children}
      {toasts.length > 0 ? (
        <div className="feedback-toast-region" role="presentation">
          {toasts.map((toast) => (
            <FeedbackToast
              key={toast.id}
              isClosing={toast.phase === "closing"}
              message={toast.message}
              onDismiss={() => dismissToast(toast.id)}
              tone={toast.tone}
            />
          ))}
        </div>
      ) : null}
    </FeedbackToastContext.Provider>
  );
}

export function useFeedbackToast(): FeedbackToastContextValue {
  const value = useContext(FeedbackToastContext);
  if (!value) {
    throw new Error("useFeedbackToast must be used within FeedbackToastProvider.");
  }
  return value;
}
