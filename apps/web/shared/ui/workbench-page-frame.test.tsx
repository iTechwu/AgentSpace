import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorkbenchPageFrameProps } from "@/shared/ui/workbench-page-frame";
import { WorkbenchPageFrame } from "@/shared/ui/workbench-page-frame";

describe("WorkbenchPageFrame", () => {
  it("uses balanced density by default and forwards section attributes", () => {
    render(
      <WorkbenchPageFrame aria-label="Workspace overview" data-hydrated="true">
        Overview
      </WorkbenchPageFrame>,
    );

    const frame = screen.getByRole("region", { name: "Workspace overview" });

    expect(frame).toHaveClass("page-shell", "workbench-page-frame", "workbench-page-frame--balanced");
    expect(frame).toHaveAttribute("data-page-density", "balanced");
    expect(frame).toHaveAttribute("aria-label", "Workspace overview");
    expect(frame).toHaveAttribute("data-hydrated", "true");
  });

  it("uses compact density while preserving the feature class", () => {
    const frameProps: WorkbenchPageFrameProps = {
      "aria-label": "Audit log",
      className: "audit-page",
      density: "compact",
    };

    const { container } = render(
      <WorkbenchPageFrame {...frameProps}>Audit</WorkbenchPageFrame>,
    );

    const frame = container.querySelector("section");

    expect(frame).toHaveClass("page-shell", "workbench-page-frame", "workbench-page-frame--compact", "audit-page");
    expect(frame).toHaveAttribute("data-page-density", "compact");
  });

  it("uses full-bleed density while preserving the feature class", () => {
    const { container } = render(
      <WorkbenchPageFrame className="knowledge-page" density="full-bleed">
        Knowledge
      </WorkbenchPageFrame>,
    );

    const frame = container.querySelector("section");

    expect(frame).toHaveClass(
      "page-shell",
      "workbench-page-frame",
      "workbench-page-frame--full-bleed",
      "knowledge-page",
    );
    expect(frame).toHaveAttribute("data-page-density", "full-bleed");
  });
});
