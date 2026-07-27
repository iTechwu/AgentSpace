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
}

interface SkillRequirementsModalProps {
  readonly configJson?: string;
  readonly collectSecrets?: boolean;
  readonly pending: boolean;
  readonly skillName: string;
  readonly onCancel: () => void;
  readonly onConfirm: (input: {
    modelProvider?: string;
    modelId?: string;
    capabilities: string[];
    projectWorkDir?: string;
    values: Record<string, string>;
    secrets: Record<string, string>;
  }) => void;
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
  pending,
  skillName,
  onCancel,
  onConfirm,
}: SkillRequirementsModalProps) {
  const { tx } = useLanguage();
  const { surfaceRef, handleBackdropMouseDown, labelId, descriptionId } = useDialogSurface<HTMLFormElement>(onCancel);
  const { requirements, configuration } = useMemo(() => readRequirements(configJson), [configJson]);
  const providers = requirements.filter((item) => item.kind === "provider").map((item) => item.value);
  const models = requirements.filter((item) => item.kind === "model").map((item) => item.value);
  const capabilities = requirements.filter((item) => item.kind === "capability").map((item) => item.value);
  const projects = requirements.filter((item) => item.kind === "project");
  const configRequirements = requirements.filter((item) => item.kind === "config");
  const secretRequirements = requirements.filter((item) => item.kind === "secret");
  const providerOptions = providers.length > 0
    ? PROVIDERS.filter(([value]) => providers.includes(value))
    : PROVIDERS;
  const [modelProvider, setModelProvider] = useState(configuration.modelProvider ?? providerOptions[0]?.[0] ?? "");
  const [modelId, setModelId] = useState(configuration.modelId ?? models[0] ?? "");
  const [selectedCapabilities, setSelectedCapabilities] = useState<string[]>(configuration.capabilities);
  const [projectWorkDir, setProjectWorkDir] = useState(configuration.projectWorkDir ?? "");
  const [values, setValues] = useState<Record<string, string>>(configuration.values);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});

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
          });
        }}
        ref={surfaceRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="modal-card__header">
          <div>
            <h3 id={labelId}>{tx("配置 Skill 安装", "Configure skill installation")}</h3>
            <p id={descriptionId}>{skillName}</p>
          </div>
          <button className="modal-close" onClick={onCancel} type="button">×</button>
        </div>
        <div className="modal-card__body skill-requirements-modal__body">
          {(providers.length > 0 || models.length > 0) ? (
            <section className="skill-requirements-modal__section">
              <h4>{tx("模型运行时", "Model runtime")}</h4>
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
              <h4>{tx("普通配置", "Configuration")}</h4>
              {configRequirements.map((requirement) => (
                <label className="form-field" key={requirement.value}>
                  <span>{requirement.value}</span>
                  <input
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setValues((current) => ({ ...current, [requirement.value]: value }));
                    }}
                    required
                    type="text"
                    value={values[requirement.value] ?? ""}
                  />
                </label>
              ))}
            </section>
          ) : null}

          {secretRequirements.length > 0 ? (
            <section className="skill-requirements-modal__section skill-requirements-modal__section--blocked">
              <h4>{tx("凭据", "Credentials")}</h4>
              <p>{collectSecrets
                ? tx("仅为当前 AI员工 加密保存；保存后不会再次显示原文。", "Encrypted only for this AI employee. The plaintext is never shown again after saving.")
                : tx("以下项不会从 GitHub 导入，也不会保存在 Skill 配置中。", "These values are not imported from GitHub and are never stored in skill configuration.")}
              </p>
              {collectSecrets ? secretRequirements.map((requirement) => (
                <label className="form-field" key={requirement.value}>
                  <span>{requirement.value}</span>
                  <input
                    autoComplete="new-password"
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setSecretValues((current) => ({ ...current, [requirement.value]: value }));
                    }}
                    required
                    type="password"
                    value={secretValues[requirement.value] ?? ""}
                  />
                </label>
              )) : (
                <ul>{secretRequirements.map((requirement) => <li key={requirement.value}>{requirement.value} · {tx("需在凭据中心配置", "Configure in Credential Center")}</li>)}</ul>
              )}
            </section>
          ) : null}
        </div>
        <div className="modal-card__footer">
          <button className="modal-secondary-button" onClick={onCancel} type="button">{tx("稍后配置", "Configure later")}</button>
          <button className="primary-button" disabled={pending} type="submit">{pending ? tx("保存中...", "Saving...") : tx("保存配置", "Save configuration")}</button>
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
      },
    };
  } catch {
    return { requirements: [], configuration: { capabilities: [], values: {} } };
  }
}

function isRequirementKind(value: unknown): value is RequirementKind {
  return value === "provider" || value === "model" || value === "capability" || value === "project" || value === "config" || value === "secret";
}
