import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider, useLanguage } from "@/features/i18n/language-provider";

const STORAGE_KEY = "dofe-agent-language";

function LanguageProbe() {
  const { language, setLanguage, tx } = useLanguage();

  return (
    <div>
      <span data-testid="language">{language}</span>
      <span>{tx("当前工作区", "Current workspace")}</span>
      <button type="button" onClick={() => setLanguage("en")}>
        {tx("切换到英文", "Switch to English")}
      </button>
    </div>
  );
}

describe("LanguageProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the server-provided language for the initial render", async () => {
    render(
      <LanguageProvider initialLanguage="zh">
        <LanguageProbe />
      </LanguageProvider>,
    );

    expect(screen.getByTestId("language")).toHaveTextContent("zh");
    expect(screen.getByText("当前工作区")).toBeInTheDocument();

    await waitFor(() => {
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("zh");
    });
  });

  it("applies the browser language preference after hydration", async () => {
    window.localStorage.setItem(STORAGE_KEY, "en");
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    render(
      <LanguageProvider initialLanguage="zh">
        <LanguageProbe />
      </LanguageProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("language")).toHaveTextContent("en");
    });

    expect(screen.getByText("Current workspace")).toBeInTheDocument();
    expect(setItemSpy).not.toHaveBeenCalledWith(STORAGE_KEY, "zh");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("en");
  });

  it("persists language changes made by the user", async () => {
    const user = userEvent.setup();

    render(
      <LanguageProvider initialLanguage="zh">
        <LanguageProbe />
      </LanguageProvider>,
    );

    await user.click(screen.getByRole("button", { name: "切换到英文" }));

    expect(screen.getByTestId("language")).toHaveTextContent("en");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("en");
  });
});
