import Link from "next/link";
import { redirect } from "next/navigation";
import {
  readChannelInvitationSync,
  readUserSync,
  readWorkspaceSync,
} from "@dofe-agent/db";
import {
  acceptChannelInvitationAction,
  rejectChannelInvitationAction,
} from "@/features/channels/channel-invitation-actions";
import { getCurrentUser } from "@/features/auth/server-auth";
import { buildWorkspacePath } from "@/features/auth/workspace-paths";

export const dynamic = "force-dynamic";

export default async function ChannelInvitationPage({
  params,
}: {
  params: Promise<{ invitationId: string }>;
}) {
  const { invitationId } = await params;
  const invitation = readChannelInvitationSync(invitationId);
  if (!invitation) {
    return (
      <ChannelInvitationShell
        body="这条群邀请不存在、已失效，或已被撤销。"
        eyebrow="群邀请"
        primaryAction={{ href: "/", label: "返回登录页" }}
        title="邀请不可用"
      />
    );
  }

  const workspace = readWorkspaceSync(invitation.workspaceId);
  const inviter = readUserSync(invitation.invitedBy);
  if (!workspace) {
    return (
      <ChannelInvitationShell
        body="这条群邀请对应的工作区不存在。"
        eyebrow="群邀请"
        primaryAction={{ href: "/", label: "返回登录页" }}
        title="邀请不可用"
      />
    );
  }

  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return (
      <ChannelInvitationShell
        body="请先通过 Dofe SSO 登录。登录完成后，再打开这条链接即可接受群邀请。"
        contextItems={[
          { label: "工作区", value: workspace.name },
          { label: "群", value: invitation.channelName },
          { label: "受邀邮箱", value: invitation.inviteeEmail ?? invitation.inviteeUserId ?? "当前账号" },
        ]}
        eyebrow="群邀请"
        primaryAction={{ href: "/", label: "去登录" }}
        title={`加入 ${workspace.name} 的 ${invitation.channelName}`}
      />
    );
  }

  if (invitation.status !== "pending") {
    return (
      <ChannelInvitationShell
        body={describeInvitationStatus(invitation.status)}
        contextItems={[
          { label: "工作区", value: workspace.name },
          { label: "群", value: invitation.channelName },
          { label: "当前状态", value: invitation.status },
        ]}
        eyebrow="群邀请"
        primaryAction={{ href: "/", label: "返回工作台" }}
        title="邀请已处理"
      />
    );
  }

  async function acceptAction() {
    "use server";

    const accepted = await acceptChannelInvitationAction(invitationId);
    redirect(buildWorkspacePath(
      accepted.workspaceSlug,
      `/im?focus=${encodeURIComponent(accepted.channelName)}`,
    ));
  }

  async function rejectAction() {
    "use server";

    await rejectChannelInvitationAction(invitationId);
    redirect("/");
  }

  return (
    <main className="auth-shell auth-shell--status">
      <section className="auth-card auth-card--status">
        <div className="auth-status-hero">
          <p className="auth-card__eyebrow">群邀请</p>
          <h1>接受后即可进入指定群</h1>
          <p className="auth-status-hero__body">
            {inviter?.displayName ?? "工作区管理员"} 邀请你加入 {workspace.name} 的 {invitation.channelName}。
          </p>
          <ul className="auth-status-highlights">
            <li>接受后会获得该群的消息、文档和附件访问权限</li>
            <li>这不会把你加入整个工作区，只授予单群访问权限</li>
            <li>拒绝后这条邀请会立即失效</li>
          </ul>
        </div>

        <div className="auth-status-card">
          <h2>确认群邀请</h2>
          <p>请确认当前登录账号与受邀邮箱一致。若邮箱不匹配，系统会拒绝接受邀请。</p>
          <dl className="auth-status-context">
            <div>
              <dt>工作区</dt>
              <dd>{workspace.name}</dd>
            </div>
            <div>
              <dt>群</dt>
              <dd>{invitation.channelName}</dd>
            </div>
            <div>
              <dt>当前账号</dt>
              <dd>{currentUser.email || currentUser.displayName}</dd>
            </div>
            <div>
              <dt>受邀邮箱</dt>
              <dd>{invitation.inviteeEmail ?? invitation.inviteeUserId ?? "未绑定"}</dd>
            </div>
          </dl>
          <div className="auth-status-actions">
            <form action={acceptAction}>
              <button className="auth-button" type="submit">接受邀请</button>
            </form>
            <form action={rejectAction}>
              <button className="workspace-ghost-button auth-status-actions__secondary" type="submit">拒绝邀请</button>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}

function ChannelInvitationShell({
  body,
  contextItems = [],
  eyebrow,
  primaryAction,
  title,
}: {
  body: string;
  contextItems?: Array<{ label: string; value: string }>;
  eyebrow: string;
  primaryAction: { href: string; label: string };
  title: string;
}) {
  return (
    <main className="auth-shell auth-shell--status">
      <section className="auth-card auth-card--status">
        <div className="auth-status-hero">
          <p className="auth-card__eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="auth-status-hero__body">{body}</p>
        </div>
        <div className="auth-status-card">
          <h2>{title}</h2>
          <p>{body}</p>
          {contextItems.length > 0 ? (
            <dl className="auth-status-context">
              {contextItems.map((item) => (
                <div key={`${item.label}-${item.value}`}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <div className="auth-status-actions">
            <Link className="auth-button" href={primaryAction.href}>{primaryAction.label}</Link>
          </div>
        </div>
      </section>
    </main>
  );
}

function describeInvitationStatus(status: string): string {
  if (status === "accepted") {
    return "这条群邀请已经被接受。";
  }
  if (status === "rejected") {
    return "这条群邀请已经被拒绝。";
  }
  if (status === "revoked") {
    return "这条群邀请已被管理员撤销。";
  }
  if (status === "expired") {
    return "这条群邀请已经过期，请联系管理员重新发送。";
  }
  return "这条群邀请当前不可处理。";
}
