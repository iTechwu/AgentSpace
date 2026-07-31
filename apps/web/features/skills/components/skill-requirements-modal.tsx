import { useMemo, useState } from "react";
import { useLanguage } from "@/features/i18n/language-provider";
import { useDialogSurface } from "@/shared/lib/use-dialog-surface";

type RequirementKind = "provider" | "model" | "capability" | "project" | "config" | "secret";

interface Requirement {
  kind: RequirementKind;
  value: string;
}

interface RequirementConfiguration {
  modelProvider?: string;
  modelId?: string;
  capabilities: string[];
  projectWorkDir?: string;
  values: Record<string, string>;
  sensitiveKeys?: string[];
}

interface SkillRequirementsModalProps {
  readonly configJson?: string;
  readonly collectSecrets?: boolean;
  readonly configuredSecretKeys?: string[];
  readonly initialConfiguration?: RequirementConfiguration;
  readonly mode?: "install" | "manage";
  readonly pending: boolean;
  readonly removingKey?: string | null;
  readonly skillName: string;
  readonly updatedAt?: string;
  readonly updatedBy?: string;
  /** Declared keys that collide with a managed runtime credential key. */
  readonly credentialKeyWarnings?: string[];
  /** key -> names of OTHER skills on the same employee that already configure it. */
  readonly reuseCandidates?: Record<string, string[]>;
  readonly onCancel: () => void;
  readonly onConfirm: (input: {
    modelProvider?: string;
    modelId?: string;
    capabilities: string[];
    projectWorkDir?: string;
    values: Record<string, string>;
    secrets: Record<string, string>;
    sensitiveKeys: string[];
  }) => void;
  readonly onRemoveKey?: (key: string) => void;
}

const PROVIDERS = [
  ["codex", "Codex"],
  ["claude", "Claude Code"],
  ["gemini", "Gemini CLI"],
  ["opencode", "OpenCode"],
  ["openclaw", "OpenClaw"],
  ["nanobot", "NanoBot"],
  ["antigravity", "Antigravity CLI"],
  ["hermes", "Hermes Agent"],
] as const;

export function SkillRequirementsModal({
  configJson,
  collectSecrets = false,
  configuredSecretKeys = [],
  initialConfiguration,
  mode = "install",
  pending,
  removingKey = null,
  skillName,
  updatedAt,
  updatedBy,
  credentialKeyWarnings = [],
  reuseCandidates = {},
  onCancel,
  onConfirm,
  onRemoveKey,
}: SkillRequirementsModalProps) {
  const { tx } = useLanguage();
  const { surfaceRef, handleBackdropMouseDown, labelId, descriptionId } = useDialogSurface<HTMLFormElement>(onCancel);
  const { requirements, configuration } = useMemo(() => readRequirements(configJson), [configJson]);
  const effectiveConfiguration = initialConfiguration ?? configuration;
  const credentialWarningSet = new Set(credentialKeyWarnings);
  const providers = requirements.filter((item) => item.kind === "provider").map((item) => item.value);
  const models = requirements.filter((item) => item.kind === "model").map((item) => item.value);
  const capabilities = requirements.filter((item) => item.kind === "capability").map((item) => item.value);
  const projects = requirements.filter((item) => item.kind === "project");
  const configRequirements = requirements.filter((item) => item.kind === "config");
  const secretRequirements = requirements.filter((item) => item.kind === "secret");
  const providerOptions = providers.length > 0
    ? PROVIDERS.filter(([value]) => providers.includes(value))
    : PROVIDERS;
  const [modelProvider, setModelProvider] = useState(effectiveConfiguration.modelProvider ?? providerOptions[0]?.[0] ?? "");
  const [modelId, setModelId] = useState(effectiveConfiguration.modelId ?? models[0] ?? "");
  const [selectedCapabilities, setSelectedCapabilities] = useState<string[]>(effectiveConfiguration.capabilities);
  const [projectWorkDir, setProjectWorkDir] = useState(effectiveConfiguration.projectWorkDir ?? "");
  const [values, setValues] = useState<Record<string, string>>(effectiveConfiguration.values);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [sensitiveKeys, setSensitiveKeys] = useState<string[]>(effectiveConfiguration.sensitiveKeys ?? []);
  const configuredKeySet = new Set(configuredSecretKeys);

  const toggleSensitive = (key: string, sensitive: boolean) => {
    setSensitiveKeys((current) => sensitive
      ? Array.from(new Set([...current, key]))
      : current.filter((value) => value !== key));
  };

  return (
    <div className="modal-backdrop" onMouseDown={handleBackdropMouseDown} role="presentation">
      <form
        aria-describedby={descriptionId}
        aria-labelledby={labelId}
        aria-modal="true"
        className="modal-card modal-card--skill-requirements"
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm({
            modelProvider: modelProvider || undefined,
            modelId: modelId || undefined,
            capabilities: selectedCapabilities,
            projectWorkDir: projectWorkDir || undefined,
            values,
            secrets: secretValues,
            sensitiveKeys,
          });
        }}
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>{mode === "manage" ? tx("管理 Skill 配置", "Manage skill configuration") : tx("配置 Skill 安装", "Configure skill installation")}</h3>
            <p id={descriptionId}>{skillName}</p>
            {mode === "manage" && (updatedAt || updatedBy) ? (
              <small className="form-field__hint">
                {tx(
                  `最近更新：${updatedBy ?? "—"} · ${updatedAt ?? ""}`,
                  `Last updated: ${updatedBy ?? "—"} · ${updatedAt ?? ""}`,
                )}
              </small>
            ) : null}
          </div>
          <button className="modal-close" onClick={onCancel} type="button">×</button>
        </div>
        <div className="modal-card__body skill-requirements-modal__body">
          {(providers.length > 0 || models.length > 0 || capabilities.length > 0) ? (
            <section className="skill-requirements-modal__section">
              <h4>{tx("模型运行时", "Model runtime")}</h4>
              {(providers.length > 0 || models.length > 0) ? (
                <div className="skill-requirements-modal__grid">
                  <label className="form-field">
                    <span>{tx("模型 Provider", "Model provider")}</span>
                    <select onChange={(event) => setModelProvider(event.currentTarget.value)} required value={modelProvider}>
                      {providerOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  {models.length > 0 ? (
                    <label className="form-field">
                      <span>{tx("模型", "Model")}</span>
                      <select onChange={(event) => setModelId(event.currentTarget.value)} required value={modelId}>
                        {models.map((model) => <option key={model} value={model}>{model}</option>)}
                      </select>
                    </label>
                  ) : null}
                </div>
              ) : null}
              {capabilities.length > 0 ? (
                <div className="skill-requirements-modal__capabilities">
                  <span>{tx("确认所需能力", "Confirm required capabilities")}</span>
                  {capabilities.map((capability) => (
                    <label key={capability}>
                      <input
                        checked={selectedCapabilities.includes(capability)}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          setSelectedCapabilities((current) => checked
                            ? [...current, capability]
                            : current.filter((item) => item !== capability));
                        }}
                        type="checkbox"
                      />
                      {capability}
                    </label>
                  ))}
                </div>
              ) : null}
              <small className="form-field__hint">
                {tx("绑定 AI员工 时会校验 Provider；模型标识仅保存为当前 AI员工 的此 Skill 配置，实际模型切换由执行引擎支持。", "Provider compatibility is checked when binding an AI employee. The model identifier is saved only for this AI employee's skill configuration; model switching depends on the execution engine.")}
              </small>
            </section>
          ) : null}

          {projects.length > 0 ? (
            <section className="skill-requirements-modal__section">
              <h4>{tx("项目工作目录", "Project working directory")}</h4>
              <label className="form-field">
                <span>{projects.map((item) => item.value).join(" · ")}</span>
                <input
                  onChange={(event) => setProjectWorkDir(event.currentTarget.value)}
                  placeholder="/workspace/project"
                  required
                  type="text"
                  value={projectWorkDir}
                />
                <small className="form-field__hint">
                  {tx("此路径仅保存为当前 AI员工 的此 Skill 配置；服务端不会访问或执行。", "This path is saved only for this AI employee's skill configuration; the server will not access or execute it.")}
                </small>
              </label>
            </section>
          ) : null}

          {configRequirements.length > 0 ? (
            <section className="skill-requirements-modal__section">
              <h4>{tx("环境变量", "Environment variables")}</h4>
              {configRequirements.map((requirement) => {
                const key = requirement.value;
                const sensitive = sensitiveKeys.includes(key);
                const isConfiguredEncrypted = sensitive && configuredKeySet.has(key);
                const reuse = reuseCandidates[key];
                return (
                  <div className="form-field skill-requirements-modal__field" key={key}>
                    <div className="skill-requirements-modal__field-head">
                      <span>{key}</span>
                      <label className="skill-requirements-modal__sensitive-toggle">
                        <input
                          checked={sensitive}
                          onChange={(event) => toggleSensitive(key, event.currentTarget.checked)}
                          type="checkbox"
                        />
                        {tx("敏感（加密保存）", "Sensitive (encrypted)")}
                      </label>
                      {mode === "manage" && onRemoveKey ? (
                        <button
                          className="modal-secondary-button skill-requirements-modal__remove"
                          disabled={pending || removingKey === key}
                          onClick={() => onRemoveKey(key)}
                          type="button"
                        >
                          {removingKey === key ? tx("删除中...", "Removing...") : tx("删除", "Remove")}
                        </button>
                      ) : null}
                    </div>
                    <input
                      autoComplete={sensitive ? "new-password" : "off"}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setValues((current) => ({ ...current, [key]: value }));
                      }}
                      placeholder={isConfiguredEncrypted ? tx("输入新值以替换；留空保留当前值", "Enter a new value to replace; leave blank to keep") : undefined}
                      required={!isConfiguredEncrypted}
                      type={sensitive ? "password" : "text"}
                      value={values[key] ?? ""}
                    />
                    {isConfiguredEncrypted ? (
                      <small className="form-field__hint">{tx("已加密保存；留空将保留当前值", "Encrypted; leave blank to keep the current value")}</small>
                    ) : null}
                    {reuse?.length ? (
                      <small className="form-field__hint">
                        {tx(
                          `该员工其他 Skill 也配置了 ${key}（${reuse.join("、")}）；同名异值会被拒绝，请复用相同值。`,
                          `Also configured by another skill (${reuse.join(", ")}); a different value will be rejected — reuse the same value.`,
                        )}
                      </small>
                    ) : null}
                    {credentialWarningSet.has(key) ? (
                      <small className="form-field__hint">
                        {tx(
                          `${key} 是受管 Runtime 凭据 Key：绑定对应 Runtime 时会与 Runtime 注入的凭据冲突并被拒绝，建议改用其他 Key。`,
                          `${key} is a managed-runtime credential key: binding a matching runtime will reject this as a conflict — use a different key.`,
                        )}
                      </small>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ) : null}

          {secretRequirements.length > 0 ? (
            <section className="skill-requirements-modal__section skill-requirements-modal__section--blocked">
              <h4>{tx("密钥环境变量", "Secret environment variables")}</h4>
              <p>{collectSecrets
                ? tx("仅为当前 AI员工 加密保存；保存后不会再次显示原文。", "Encrypted only for this AI employee. The plaintext is never shown again after saving.")
                : tx("以下项不会从 GitHub 导入，也不会保存在 Skill 配置中。", "These values are not imported from GitHub and are never stored in skill configuration.")}
              </p>
              {collectSecrets ? secretRequirements.map((requirement) => {
                const key = requirement.value;
                const isConfigured = configuredKeySet.has(key);
                const reuse = reuseCandidates[key];
                return (
                  <div className="form-field skill-requirements-modal__field" key={key}>
                    <div className="skill-requirements-modal__field-head">
                      <span>{key}</span>
                      {mode === "manage" && onRemoveKey ? (
                        <button
                          className="modal-secondary-button skill-requirements-modal__remove"
                          disabled={pending || removingKey === key || !isConfigured}
                          onClick={() => onRemoveKey(key)}
                          type="button"
                        >
                          {removingKey === key ? tx("删除中...", "Removing...") : tx("删除", "Remove")}
                        </button>
                      ) : null}
                    </div>
                    <input
                      aria-label={key}
                      autoComplete="new-password"
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setSecretValues((current) => ({ ...current, [key]: value }));
                      }}
                      placeholder={isConfigured ? tx("输入新值以替换", "Enter a new value to replace") : undefined}
                      required={!isConfigured}
                      type="password"
                      value={secretValues[key] ?? ""}
                    />
                    {isConfigured ? <small className="form-field__hint">{tx("已配置；留空将保留当前值", "Configured; leave blank to keep the current value")}</small> : null}
                    {reuse?.length ? (
                      <small className="form-field__hint">
                        {tx(
                          `该员工其他 Skill 也配置了 ${key}（${reuse.join("、")}）；同名异值会被拒绝，请复用相同值。`,
                          `Also configured by another skill (${reuse.join(", ")}); a different value will be rejected — reuse the same value.`,
                        )}
                      </small>
                    ) : null}
                    {credentialWarningSet.has(key) ? (
                      <small className="form-field__hint">
                        {tx(
                          `${key} 是受管 Runtime 凭据 Key：绑定对应 Runtime 时会与 Runtime 注入的凭据冲突并被拒绝，建议改用其他 Key。`,
                          `${key} is a managed-runtime credential key: binding a matching runtime will reject this as a conflict — use a different key.`,
                        )}
                      </small>
                    ) : null}
                  </div>
                );
              }) : (
                <ul>{secretRequirements.map((requirement) => <li key={requirement.value}>{requirement.value} · {tx("需在凭据中心配置", "Configure in Credential Center")}</li>)}</ul>
              )}
            </section>
          ) : null}
        </div>
        <div className="modal-card__footer">
          <button className="modal-secondary-button" onClick={onCancel} type="button">
            {mode === "manage" ? tx("取消", "Cancel") : tx("稍后配置", "Configure later")}
          </button>
          <button className="primary-button" disabled={pending} type="submit">
            {pending ? tx("保存中...", "Saving...") : mode === "manage" ? tx("保存更改", "Save changes") : tx("保存配置", "Save configuration")}
          </button>
        </div>
      </form>
    </div>
  );
}

function readRequirements(configJson: string | undefined): { requirements: Requirement[]; configuration: RequirementConfiguration } {
  try {
    const config = JSON.parse(configJson ?? "{}") as { requirements?: unknown; requirementConfiguration?: unknown };
    const requirements = Array.isArray(config.requirements)
      ? config.requirements.filter((item): item is Requirement => (
        Boolean(item) && typeof item === "object" && !Array.isArray(item)
        && isRequirementKind((item as { kind?: unknown }).kind)
        && typeof (item as { value?: unknown }).value === "string"
      ))
      : [];
    const stored = config.requirementConfiguration;
    const record = stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
    const values = record.values && typeof record.values === "object" && !Array.isArray(record.values)
      ? Object.fromEntries(Object.entries(record.values).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    return {
      requirements,
      configuration: {
        modelProvider: typeof record.modelProvider === "string" ? record.modelProvider : undefined,
        modelId: typeof record.modelId === "string" ? record.modelId : undefined,
        capabilities: Array.isArray(record.capabilities)
          ? record.capabilities.filter((value): value is string => typeof value === "string")
          : [],
        projectWorkDir: typeof record.projectWorkDir === "string" ? record.projectWorkDir : undefined,
        values,
        sensitiveKeys: Array.isArray(record.sensitiveKeys)
          ? record.sensitiveKeys.filter((value): value is string => typeof value === "string")
          : [],
      },
    };
  } catch {
    return { requirements: [], configuration: { capabilities: [], values: {} } };
  }
}

function isRequirementKind(value: unknown): value is RequirementKind {
  return value === "provider" || value === "model" || value === "capability" || value === "project" || value === "config" || value === "secret";
}
