import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkspacePageLoading } from "@/shared/ui/workspace-page-loading";

describe("WorkspacePageLoading", () => {
  it.each([
    ["im", "workspace-page-loading__conversation"],
    ["agents", "workspace-page-loading__split"],
    ["task-board", "workspace-page-loading__board"],
    ["performance", "workspace-page-loading__overview"],
  ] as const)("uses the %s page skeleton", (moduleId, expectedClassName) => {
    const { container } = render(<WorkspacePageLoading loadingLabel="Loading performance" moduleId={moduleId} />);

    expect(screen.getByRole("progressbar", { name: "Loading performance" })).toBeInTheDocument();
    expect(screen.getByTestId("workspace-page-skeleton")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(`.${expectedClassName}`)).toBeInTheDocument();
  });
});
