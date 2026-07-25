import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TablesPageClient } from "@/features/tables/tables-page-client";
import { LanguageProvider } from "@/features/i18n/language-provider";
import type { DataTablesPageData } from "@/features/dashboard/data";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

vi.mock("@/features/tables/actions", () => ({
  createDataTableAction: vi.fn(async () => {}),
  deleteDataTableAction: vi.fn(async () => {}),
  addDataRowAction: vi.fn(async () => {}),
  updateDataRowAction: vi.fn(async () => {}),
  deleteDataRowAction: vi.fn(async () => {}),
}));

function mockMatchMedia(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches,
      media: "(max-width: 860px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

const data: DataTablesPageData = {
  tables: [
    {
      id: "table-1",
      name: "行程表",
      status: "active",
      createdBy: "techwu",
      createdAt: "2026-04-10T08:00:00.000Z",
      updatedAt: "2026-04-10T09:00:00.000Z",
      columns: [
        { id: "col-city", name: "城市", type: "text" },
      ],
      rows: [
        {
          id: "row-1",
          createdBy: "techwu",
          createdAt: "2026-04-10T08:30:00.000Z",
          updatedAt: "2026-04-10T08:30:00.000Z",
          cells: { "col-city": "大阪" },
        },
      ],
    },
  ],
  totalCount: 1,
  activeCount: 1,
  channels: [{ name: "travel" }],
  agents: [{ id: "atlas", name: "Atlas" }],
};

describe("TablesPageClient", () => {
  beforeEach(() => {
    mockMatchMedia(false);
  });

  it("switches between table list and detail on compact layouts", async () => {
    mockMatchMedia(true);
    const user = userEvent.setup();

    render(
      <LanguageProvider>
        <TablesPageClient data={data} />
      </LanguageProvider>,
    );

    expect(screen.getByRole("button", { name: /行程表/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回数据表列表" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\+ 添加行/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /行程表/i }));

    expect(await screen.findByRole("button", { name: "返回数据表列表" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\+ 添加行/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue("大阪")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回数据表列表" }));

    expect(screen.getByRole("button", { name: /行程表/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回数据表列表" })).not.toBeInTheDocument();
  });
});
