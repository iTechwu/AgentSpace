import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  SidebarVisibilityProvider,
  SIDEBAR_VISIBILITY_STORAGE_KEY,
  useSidebarVisibility,
} from "@/features/dashboard/sidebar-visibility-provider";

function SidebarVisibilityProbe() {
  const { visibility } = useSidebarVisibility();

  return (
    <div>
      <span data-testid="approvals">{String(visibility.approvals)}</span>
      <span data-testid="messages">{String(visibility.messages)}</span>
    </div>
  );
}

describe("SidebarVisibilityProvider", () => {
  it("migrates legacy stored visibility to the compact default sidebar", async () => {
    window.localStorage.setItem(SIDEBAR_VISIBILITY_STORAGE_KEY, JSON.stringify({
      approvals: true,
      messages: true,
    }));

    render(
      <SidebarVisibilityProvider>
        <SidebarVisibilityProbe />
      </SidebarVisibilityProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("approvals")).toHaveTextContent("false");
    });
    expect(screen.getByTestId("messages")).toHaveTextContent("true");
  });
});
