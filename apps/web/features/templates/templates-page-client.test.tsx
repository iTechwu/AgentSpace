import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TemplatesPageClient } from "@/features/templates/templates-page-client";
import { LanguageProvider } from "@/features/i18n/language-provider";
import type { TemplatesPageData } from "@/features/dashboard/data";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

vi.mock("@/features/templates/actions", () => ({
  createTemplateAction: vi.fn(async () => {}),
  updateTemplateAction: vi.fn(async () => {}),
  deleteTemplateAction: vi.fn(async () => {}),
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

const data: TemplatesPageData = {
  templates: [
    {
      id: "template-1",
      category: "task",
      name: "旅行任务模板",
      description: "标准旅行任务说明",
      configJson: "{\"priority\":\"high\"}",
      builtIn: false,
      createdBy: "techwu",
      createdAt: "2026-04-10T08:00:00.000Z",
      updatedAt: "2026-04-10T09:00:00.000Z",
    },
  ],
  totalCount: 1,
  builtInCount: 0,
  customCount: 1,
};

describe("TemplatesPageClient", () => {
  beforeEach(() => {
    mockMatchMedia(false);
  });

  it("switches between template list and detail on compact layouts", async () => {
    mockMatchMedia(true);
    const user = userEvent.setup();

    render(
      <LanguageProvider>
        <TemplatesPageClient data={data} />
      </LanguageProvider>,
    );

    expect(screen.getByRole("button", { name: "创建模板" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /旅行任务模板/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回模板列表" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /旅行任务模板/i }));

    expect(await screen.findByRole("button", { name: "返回模板列表" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑" })).toBeInTheDocument();
    expect(screen.getByText((content) => content.includes("标准旅行任务说明"))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "返回模板列表" }));

    expect(screen.getByRole("button", { name: /旅行任务模板/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "返回模板列表" })).not.toBeInTheDocument();
  });
});
