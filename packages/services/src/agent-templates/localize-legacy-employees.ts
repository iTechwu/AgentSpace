import { getSystemAgentTemplatePreset } from "@dofe-agent/domain";
import type { ActiveEmployee } from "@dofe-agent/domain/workspace";

const TEMPLATE_ORIGIN_PATTERN = /^agent-template:([a-z-]+):v(\d+)$/;

/**
 * Upgrades the profile text of employees created from an older built-in template.
 * The stable employee name is deliberately left alone because it is referenced by
 * runtime bindings, channel membership, skills, and task history.
 */
export function localizeLegacySystemTemplateEmployeesSync(employees: ActiveEmployee[]): number {
  let upgraded = 0;

  for (const employee of employees) {
    const match = TEMPLATE_ORIGIN_PATTERN.exec(employee.origin);
    if (!match) {
      continue;
    }

    const template = getSystemAgentTemplatePreset(match[1]);
    const sourceVersion = Number.parseInt(match[2], 10);
    if (!template || !Number.isSafeInteger(sourceVersion) || sourceVersion >= template.version) {
      continue;
    }

    employee.role = template.defaultTitle;
    employee.remarkName = template.defaultRemarkName;
    employee.summary = template.summary;
    employee.traits = [...template.traits];
    employee.fit = template.fit;
    employee.instructions = template.instructions;
    employee.origin = `agent-template:${template.id}:v${template.version}`;
    upgraded += 1;
  }

  return upgraded;
}
