import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceModuleRouteState } from "@/features/dashboard/use-workspace-module-route-state";

let pathname = "/w/acme/inbox";
let searchParams = new URLSearchParams();

const routerPush = vi.fn();
const routerReplace = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPush,
    replace: routerReplace,
  }),
  usePathname: () => pathname,
  useSearchParams: () => ({
    get: (key: string) => searchParams.get(key),
    toString: () => searchParams.toString(),
  }),
}));

describe("useWorkspaceModuleRouteState", () => {
  beforeEach(() => {
    pathname = "/w/acme/inbox";
    searchParams = new URLSearchParams();
    window.history.replaceState(null, "", pathname);
    routerPush.mockReset();
    routerReplace.mockReset();
  });

  it("drops stale client route state after a real navigation changes the browser path", async () => {
    const { rerender } = render(<RouteStateProbe />);

    expect(screen.getByTestId("route-state")).toHaveTextContent("url:inbox:/inbox:");

    fireEvent.click(screen.getByRole("button", { name: "local im" }));

    expect(screen.getByTestId("route-state")).toHaveTextContent("client:im:/im:");

    act(() => {
      pathname = "/w/acme/settings/integrations";
      window.history.replaceState(null, "", pathname);
      rerender(<RouteStateProbe />);
    });

    await waitFor(() => {
      expect(screen.getByTestId("route-state")).toHaveTextContent("url:settings:/settings/integrations:integrations");
    });
  });
});

function RouteStateProbe() {
  const { navigateHrefLocally, routeState, routeStateSource } = useWorkspaceModuleRouteState("acme");

  return (
    <>
      <div data-testid="route-state">
        {[
          routeStateSource,
          routeState.moduleId,
          routeState.appPath,
          routeState.settingsPath.join("/"),
        ].join(":")}
      </div>
      <button onClick={() => navigateHrefLocally("/w/acme/im")} type="button">
        local im
      </button>
    </>
  );
}
