import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { normalizeSkillEgressAllowlist, normalizeSkillRunnerCommandSegment } from "@dofe-agent/domain";

/**
 * JSON Schema (strict) for `.dofe/manifest.json` (DSP v1).
 *
 * Compiled once with ajv. The manifest carries platform metadata that cannot
 * be safely expressed in Markdown; the upstream `SKILL.md` is never rewritten.
 * See 02-架构设计.md §2.
 */

export const dspManifestJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "artifact", "files"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    artifact: {
      type: "object",
      additionalProperties: false,
      required: ["name", "version"],
      properties: {
        name: { type: "string", minLength: 1 },
        version: { type: "string" },
        sha256: { type: "string" },
      },
    },
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "sha256", "size", "mediaType"],
        properties: {
          path: { type: "string", minLength: 1 },
          sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
          size: { type: "integer", minimum: 0 },
          mediaType: { type: "string", minLength: 1 },
          mode: { type: "string", pattern: "^0?[0-7]{3,4}$" },
        },
      },
    },
    dependencies: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "name", "version"],
        properties: {
          kind: { type: "string", enum: ["npm", "pip", "uv", "system"] },
          name: { type: "string", minLength: 1 },
          version: { type: "string", minLength: 1 },
          integrity: { type: "string" },
        },
      },
    },
    capabilities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "catalogSlug"],
        properties: {
          kind: { type: "string", enum: ["mcp", "cli"] },
          catalogSlug: { type: "string", minLength: 1 },
          requiredTools: {
            type: "array",
            items: { type: "string", minLength: 1 },
          },
        },
      },
    },
    services: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["catalogSlug", "templateVersion", "required"],
        properties: {
          catalogSlug: { type: "string", minLength: 1 },
          templateVersion: { type: "string", minLength: 1 },
          required: { type: "boolean" },
        },
      },
    },
    entrypoints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "kind", "path", "runtime"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 128 },
          kind: { type: "string", const: "script" },
          path: { type: "string", minLength: 1 },
          runtime: { type: "string", enum: ["node", "python", "bash"] },
          configKeys: {
            type: "array",
            uniqueItems: true,
            maxItems: 64,
            items: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,127}$" },
          },
        },
      },
    },
    // Egress declaration. Omitting `network` entirely = no egress (Runner runs
    // `--network none`). `network: {}` = unrestricted egress (highest risk, needs
    // explicit approval). `network: { egressAllowlist: [host...] }` = egress
    // limited to the allowlist (DNS-poison + /etc/hosts pinning at run time).
    network: {
      type: "object",
      additionalProperties: false,
      properties: {
        egressAllowlist: {
          type: "array",
          minItems: 1,
          items: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: "log" });
(addFormats as unknown as (ajv: Ajv) => Ajv)(ajv);
const compiledValidate = ajv.compile(dspManifestJsonSchema);

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

/** Validate a value against the DSP manifest JSON Schema. */
export function validateDspManifest(value: unknown): ManifestValidation {
  if (compiledValidate(value)) {
    const entrypoints = (value as { entrypoints?: Array<{ id: string }> }).entrypoints ?? [];
    const normalizedIds = new Set<string>();
    const errors: string[] = [];
    for (const entrypoint of entrypoints) {
      const normalizedId = normalizeSkillRunnerCommandSegment(entrypoint.id);
      if (normalizedIds.has(normalizedId)) {
        errors.push(`/entrypoints duplicate normalized id "${normalizedId}"`);
      }
      normalizedIds.add(normalizedId);
    }
    // Egress entries must pass the shared strict origin parser so the approved
    // object and the runtime-enforced object are identical. Skill manifests go
    // through DNS-pin enforcement only, which cannot restrict ports — explicit
    // non-default ports are rejected here (allowExplicitPort stays off).
    const egressAllowlist = (value as { network?: { egressAllowlist?: string[] } }).network?.egressAllowlist ?? [];
    for (const invalid of normalizeSkillEgressAllowlist(egressAllowlist).invalid) {
      errors.push(`/network/egressAllowlist entry "${invalid.entry}": ${invalid.reason}`);
    }
    return { ok: errors.length === 0, errors };
  }
  const errors = (compiledValidate.errors ?? []).map((entry) => {
    const path = entry.instancePath || "/";
    return `${path} ${entry.message ?? "is invalid"}`.trim();
  });
  return { ok: false, errors };
}
