import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [".next/**", "node_modules/**", "coverage/**", "playwright-report/**", "test-results/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // ESLint 10 把以下两条新规则纳入了 @eslint/js recommended：
  //   - no-useless-assignment
  //   - preserve-caught-error
  // 它们会在既有已提交代码上新增报错。是否启用属于代码质量策略决策，
  // 不应借依赖升级悄悄引入，故在此显式关闭，保持与 ESLint 9 等效的规则面。
  // 团队可后续单独评估启用并清理违规点。
  {
    rules: {
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
    },
  },
);
