// Models client 注入点：默认内部客户端 + 测试替换钩子。
import {
  getModelsInternalClient,
  preflightModelsBillingByScopeAsync,
} from "../models/client.ts";
import type {
  ModelsInternalRevokeRuntimeCredentialRequest,
  ModelsInternalRotateRuntimeCredentialRequest,
  ModelsInternalRuntimeCredential,
} from "@dofe/models-sdk";
import type {
  ModelsCreateResult,
} from "./runtime-provisioning-models-types.ts";

export interface ModelsClientLike {
  models: {
    list(args: { query: { tenantId: string } }): Promise<{ list: unknown[] }>;
  };
  billing: {
    preflightByScope(args: { body: {
      scope: {
        tenantId: string;
        ssoTeamId: string;
        teamId: null;
        requestId: string;
        source: "admin";
      };
      estimatedCharge: number;
      reserve: false;
    } }): Promise<{
      allowed: boolean;
      availableBalance?: string | number | null;
      estimatedCharge?: string | number | null;
      currency?: string;
      code?: string;
      message?: string;
    }>;
  };
  runtimeCredentials: {
    create(args: { body: Record<string, unknown> }): Promise<ModelsCreateResult>;
    get(args: { params: { id: string }; query: { tenantId: string; teamId: string } }): Promise<ModelsInternalRuntimeCredential>;
    rotate(args: { params: { id: string }; body: ModelsInternalRotateRuntimeCredentialRequest }): Promise<ModelsCreateResult>;
    revoke(args: { params: { id: string }; body: ModelsInternalRevokeRuntimeCredentialRequest }): Promise<{ ok: boolean }>;
    models(args: { params: { id: string }; query?: { protocol?: string; tenantId?: string; teamId?: string } }): Promise<{ list: unknown[]; total: number }>;
  };
}

export let clientProvider: () => ModelsClientLike = () => {
  const client = getModelsInternalClient();
  return {
    ...client,
    billing: {
      preflightByScope: (
        { body }: Parameters<ModelsClientLike["billing"]["preflightByScope"]>[0],
      ) => preflightModelsBillingByScopeAsync(body),
    },
  } as unknown as ModelsClientLike;
};

export function setProvisioningModelsClientProviderForTests(provider: () => ModelsClientLike): void {
  clientProvider = provider;
}
