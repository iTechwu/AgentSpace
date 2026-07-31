import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "@/features/i18n/language-provider";
import { WorkspaceModuleCacheProvider } from "@/features/dashboard/workspace-module-cache";
import { WorkspaceModuleHost } from "@/features/dashboard/workspace-module-host";
import { parseWorkspaceModulePath } from "@/features/dashboard/workspace-module-route";

function renderHost(input: {
  children: React.ReactNode;
  routePath: string;
  routeStateSource: "url" | "next" | "client";
}) {
  return (
    <LanguageProvider>
      <WorkspaceModuleCacheProvider workspaceId="workspace-alpha">
        <WorkspaceModuleHost
          routeState={parseWorkspaceModulePath(input.routePath)}
          routeStateSource={input.routeStateSource}
          workspaceId="workspace-alpha"
          workspaceSlug="workspace-alpha"
        >
          {input.children}
        </WorkspaceModuleHost>
      </WorkspaceModuleCacheProvider>
    </LanguageProvider>
  );
}

describe("WorkspaceModuleHost", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  });

  it("restores the preserved route children snapshot when returning to its client route", () => {
    const view = render(renderHost({
      routePath: "/w/workspace-alpha/im",
      routeStateSource: "url",
      children: <div>Message route child</div>,
    }));

    expect(screen.getByText("Message route child")).toBeInTheDocument();

    view.rerender(renderHost({
      routePath: "/w/workspace-alpha/inbox",
      routeStateSource: "client",
      children: <div>Notification route child</div>,
    }));

    view.rerender(renderHost({
      routePath: "/w/workspace-alpha/im",
      routeStateSource: "client",
      children: <div>Notification route child</div>,
    }));

    expect(screen.getByText("Message route child")).toBeInTheDocument();
    expect(screen.queryByText("Notification route child")).not.toBeInTheDocument();
  });

  it("keeps the current page visible while an uncached client module shows its skeleton", () => {
    const view = render(renderHost({
      routePath: "/w/workspace-alpha/im",
      routeStateSource: "url",
      children: <div>Current message page</div>,
    }));

    view.rerender(renderHost({
      routePath: "/w/workspace-alpha/performance",
      routeStateSource: "client",
      children: <div>Pending performance page</div>,
    }));

    expect(screen.getByText("Current message page")).toBeVisible();
    expect(screen.getByTestId("workspace-page-skeleton")).toBeInTheDocument();
    expect(screen.getByText("Current message page").closest(".workspace-module-stage")).toHaveAttribute(
      "data-retained-content",
      "true",
    );
  });
});
