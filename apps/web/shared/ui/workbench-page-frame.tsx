import type { ComponentPropsWithoutRef } from "react";

export type WorkbenchPageDensity = "balanced" | "compact" | "full-bleed";

interface WorkbenchPageFrameProps extends ComponentPropsWithoutRef<"section"> {
  readonly density?: WorkbenchPageDensity;
}

export function WorkbenchPageFrame({
  children,
  className,
  density = "balanced",
  ...sectionProps
}: WorkbenchPageFrameProps) {
  const frameClassName = [
    "page-shell",
    "workbench-page-frame",
    `workbench-page-frame--${density}`,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <section {...sectionProps} className={frameClassName} data-page-density={density}>
      {children}
    </section>
  );
}
