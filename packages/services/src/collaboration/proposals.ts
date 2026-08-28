import { DEFAULT_WORKSPACE_ID } from "@dofe-agent/db";
import type {
  CollaborationActorRef,
  CollaborationChangeProposal,
  CollaborativeObjectType,
} from "@dofe-agent/domain";
import { createOpaqueId } from "../shared/helpers.ts";
import { ensureWorkspaceStateSync, writeWorkspaceStateSync } from "../shared/state-io.ts";
import { appendCollaborationActivity } from "./activity.ts";
import { resolveCollaborativeObject } from "./registry.ts";

export function listCollaborationChangeProposalsSync(
  filter: {
    objectType?: CollaborativeObjectType;
    objectId?: string;
    status?: CollaborationChangeProposal["status"];
  } = {},
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationChangeProposal[] {
  return ensureWorkspaceStateSync(workspaceId).collaborationChangeProposals.filter((proposal) => {
    if (filter.objectType && proposal.objectType !== filter.objectType) {
      return false;
    }
    if (filter.objectId && proposal.objectId !== filter.objectId) {
      return false;
    }
    if (filter.status && proposal.status !== filter.status) {
      return false;
    }
    return true;
  });
}

export function createCollaborationChangeProposalSync(
  input: {
    objectType: CollaborativeObjectType;
    objectId: string;
    proposedBy: CollaborationActorRef;
    title: string;
    summary: string;
    patch: Record<string, unknown>;
  },
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationChangeProposal {
  const state = ensureWorkspaceStateSync(workspaceId);
  const object = resolveCollaborativeObject(state, input, workspaceId);
  const title = input.title.trim();
  const summary = input.summary.trim();
  const proposedById = input.proposedBy.id.trim();
  if (!proposedById) {
    throw new Error("Proposal author id is required.");
  }
  if (!title) {
    throw new Error("Proposal title is required.");
  }
  if (!summary) {
    throw new Error("Proposal summary is required.");
  }

  const now = new Date().toISOString();
  const proposal: CollaborationChangeProposal = {
    id: `collab-proposal-${createOpaqueId()}`,
    workspaceId,
    objectType: object.objectType,
    objectId: object.objectId,
    proposedByType: input.proposedBy.type,
    proposedById,
    title,
    summary,
    patch: input.patch,
    status: "open",
    createdAt: now,
    updatedAt: now,
  };

  state.collaborationChangeProposals.unshift(proposal);
  appendCollaborationActivity(
    state,
    {
      objectType: object.objectType,
      objectId: object.objectId,
      actor: input.proposedBy,
      verb: "proposal.created",
      title,
      body: summary,
      metadata: { proposalId: proposal.id },
    },
    workspaceId,
  );
  writeWorkspaceStateSync(state, workspaceId);
  return proposal;
}

export function acceptCollaborationChangeProposalSync(
  input: {
    proposalId: string;
    decidedByUserId: string;
  },
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationChangeProposal {
  return decideCollaborationChangeProposalSync({ ...input, status: "accepted" }, workspaceId);
}

export function rejectCollaborationChangeProposalSync(
  input: {
    proposalId: string;
    decidedByUserId: string;
  },
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationChangeProposal {
  return decideCollaborationChangeProposalSync({ ...input, status: "rejected" }, workspaceId);
}

function decideCollaborationChangeProposalSync(
  input: {
    proposalId: string;
    decidedByUserId: string;
    status: "accepted" | "rejected";
  },
  workspaceId = DEFAULT_WORKSPACE_ID,
): CollaborationChangeProposal {
  const state = ensureWorkspaceStateSync(workspaceId);
  const proposal = state.collaborationChangeProposals.find((item) => item.id === input.proposalId);
  if (!proposal) {
    throw new Error(`Collaboration change proposal "${input.proposalId}" does not exist.`);
  }
  if (proposal.status !== "open") {
    throw new Error(`Collaboration change proposal "${input.proposalId}" is already ${proposal.status}.`);
  }
  const decidedByUserId = input.decidedByUserId.trim();
  if (!decidedByUserId) {
    throw new Error("Proposal decision user id is required.");
  }

  const now = new Date().toISOString();
  proposal.status = input.status;
  proposal.decidedByUserId = decidedByUserId;
  proposal.decidedAt = now;
  proposal.updatedAt = now;
  appendCollaborationActivity(
    state,
    {
      objectType: proposal.objectType,
      objectId: proposal.objectId,
      actor: { type: "human", id: decidedByUserId },
      verb: `proposal.${input.status}`,
      title: `Proposal ${input.status}`,
      body: proposal.title,
      metadata: { proposalId: proposal.id },
    },
    workspaceId,
  );
  writeWorkspaceStateSync(state, workspaceId);
  return proposal;
}
