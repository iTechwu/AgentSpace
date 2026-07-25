"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { AppIcon, type AppIconName } from "@/shared/ui/app-icon";

export const WORKSPACE_ONBOARDING_REPLAY_EVENT = "dofe-agent:workspace-onboarding:replay";

const WORKSPACE_ONBOARDING_DONE_VALUE = "done";
const WORKSPACE_ONBOARDING_STORAGE_PREFIX = "dofe-agent-workspace-onboarding:v1";

export interface WorkspaceOnboardingStep {
  body: string;
  href?: string;
  icon: AppIconName;
  id: string;
  primaryActionLabel?: string;
  target: string;
  title: string;
}

interface GuideRect {
  height: number;
  left: number;
  top: number;
  width: number;
}

export function buildWorkspaceOnboardingStorageKey(userId: string, workspaceId: string): string {
  return `${WORKSPACE_ONBOARDING_STORAGE_PREFIX}:${workspaceId}:${userId}`;
}

export function WorkspaceOnboardingGuide({
  disabled = false,
  onActiveChange,
  steps,
  storageKey,
  tx,
  onNavigate,
}: {
  disabled?: boolean;
  onActiveChange?: (active: boolean) => void;
  onNavigate?: (href: string) => void;
  steps: WorkspaceOnboardingStep[];
  storageKey: string;
  tx: (zh: string, en: string) => string;
}) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [targetRect, setTargetRect] = useState<GuideRect | null>(null);
  const autoStartedStorageKeyRef = useRef<string | null>(null);
  const nextButtonRef = useRef<HTMLButtonElement | null>(null);
  const activeStep = steps[activeIndex] ?? null;
  const isLastStep = activeIndex >= steps.length - 1;

  useEffect(() => {
    if (disabled || steps.length === 0 || autoStartedStorageKeyRef.current === storageKey) {
      return;
    }
    autoStartedStorageKeyRef.current = storageKey;

    try {
      if (window.localStorage.getItem(storageKey) === WORKSPACE_ONBOARDING_DONE_VALUE) {
        return;
      }
    } catch {
      return;
    }

    setActiveIndex(0);
    setIsOpen(true);
  }, [disabled, steps.length, storageKey]);

  useEffect(() => {
    function handleReplay(): void {
      if (disabled || steps.length === 0) {
        return;
      }
      setActiveIndex(0);
      setIsOpen(true);
    }

    window.addEventListener(WORKSPACE_ONBOARDING_REPLAY_EVENT, handleReplay);
    return () => window.removeEventListener(WORKSPACE_ONBOARDING_REPLAY_EVENT, handleReplay);
  }, [disabled, steps.length]);

  useEffect(() => {
    onActiveChange?.(isOpen);
  }, [isOpen, onActiveChange]);

  useEffect(() => {
    if (!isOpen || steps.length === 0) {
      return;
    }
    if (activeIndex >= steps.length) {
      setActiveIndex(Math.max(0, steps.length - 1));
    }
  }, [activeIndex, isOpen, steps.length]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        completeGuide();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  useEffect(() => {
    if (!isOpen || !activeStep) {
      setTargetRect(null);
      return;
    }

    function updateTargetRect(scrollTarget = false): void {
      const target = document.querySelector<HTMLElement>(`[data-onboarding-target="${activeStep.target}"]`);
      if (!target) {
        setTargetRect(null);
        return;
      }

      if (scrollTarget && typeof target.scrollIntoView === "function") {
        target.scrollIntoView({ block: "center", inline: "nearest" });
      }

      const rect = target.getBoundingClientRect();
      setTargetRect({
        height: rect.height,
        left: rect.left,
        top: rect.top,
        width: rect.width,
      });
    }

    function handleResize(): void {
      updateTargetRect();
    }

    function handleScroll(): void {
      updateTargetRect();
    }

    updateTargetRect(true);
    const timeoutId = window.setTimeout(() => updateTargetRect(), 80);
    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [activeStep, isOpen]);

  useEffect(() => {
    if (isOpen) {
      nextButtonRef.current?.focus({ preventScroll: true });
    }
  }, [activeIndex, isOpen]);

  function completeGuide(): void {
    try {
      window.localStorage.setItem(storageKey, WORKSPACE_ONBOARDING_DONE_VALUE);
    } catch {
      // The tour still closes when browser storage is unavailable.
    }
    setIsOpen(false);
  }

  function showNextStep(): void {
    if (isLastStep) {
      completeGuide();
      return;
    }
    setActiveIndex((current) => Math.min(current + 1, steps.length - 1));
  }

  function handlePrimaryAction(): void {
    if (activeStep?.href && onNavigate) {
      onNavigate(activeStep.href);
      return;
    }
    showNextStep();
  }

  if (!isOpen || !activeStep) {
    return null;
  }

  return (
    <div className="workspace-onboarding">
      <div className="workspace-onboarding__veil" />
      {targetRect ? <div className="workspace-onboarding__spotlight" style={getSpotlightStyle(targetRect)} /> : null}
      <section
        aria-label={tx("新手引导", "Onboarding tour")}
        className="workspace-onboarding__panel"
        role="dialog"
        style={getPanelStyle(targetRect)}
      >
        <div className="workspace-onboarding__header">
          <span className="workspace-onboarding__icon">
            <AppIcon name={activeStep.icon} />
          </span>
          <div>
            <p className="workspace-onboarding__eyebrow">
              {tx("新手引导", "Onboarding")} {activeIndex + 1}/{steps.length}
            </p>
            <h2>{activeStep.title}</h2>
          </div>
          <button
            aria-label={tx("关闭新手引导", "Close onboarding")}
            className="workspace-onboarding__close"
            onClick={completeGuide}
            type="button"
          >
            <AppIcon name="close" />
          </button>
        </div>
        <p className="workspace-onboarding__body">{activeStep.body}</p>
        <div aria-hidden="true" className="workspace-onboarding__progress">
          {steps.map((step, index) => (
            <span
              className={index <= activeIndex ? "workspace-onboarding__progress-dot workspace-onboarding__progress-dot--active" : "workspace-onboarding__progress-dot"}
              key={step.id}
            />
          ))}
        </div>
        <div className="workspace-onboarding__actions">
          <div className="workspace-onboarding__step-actions workspace-onboarding__step-actions--primary">
            {activeStep.primaryActionLabel ? (
              <button className="primary-button" onClick={handlePrimaryAction} type="button">
                {activeStep.primaryActionLabel}
              </button>
            ) : null}
          </div>
          <div className="workspace-onboarding__step-actions">
            <button className="modal-secondary-button" onClick={completeGuide} type="button">
              {tx("跳过", "Skip")}
            </button>
            <button
              className="modal-secondary-button"
              disabled={activeIndex === 0}
              onClick={() => setActiveIndex((current) => Math.max(current - 1, 0))}
              type="button"
            >
              {tx("上一步", "Back")}
            </button>
            <button className="primary-button" onClick={showNextStep} ref={nextButtonRef} type="button">
              {isLastStep ? tx("完成", "Done") : tx("下一步", "Next")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function getSpotlightStyle(rect: GuideRect): CSSProperties {
  const padding = 7;
  return {
    height: Math.max(rect.height + padding * 2, 44),
    left: Math.max(rect.left - padding, 8),
    top: Math.max(rect.top - padding, 8),
    width: Math.max(rect.width + padding * 2, 44),
  };
}

function getPanelStyle(rect: GuideRect | null): CSSProperties {
  if (!rect || typeof window === "undefined" || window.innerWidth <= 760) {
    return {};
  }

  const margin = 18;
  const width = 360;
  const maxTop = Math.max(margin, window.innerHeight - 280);
  const top = Math.min(Math.max(rect.top, margin), maxTop);

  if (rect.left + rect.width + margin + width <= window.innerWidth) {
    return {
      left: rect.left + rect.width + margin,
      top,
    };
  }

  if (rect.left - margin - width >= margin) {
    return {
      left: rect.left - margin - width,
      top,
    };
  }

  return {
    left: Math.min(Math.max(rect.left, margin), window.innerWidth - width - margin),
    top: Math.min(Math.max(rect.top + rect.height + margin, margin), maxTop),
  };
}
