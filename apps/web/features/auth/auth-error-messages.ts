export function translateAuthError(
  message: string,
  tx: (zh: string, en: string) => string,
): string {
  if (message === "auth.sso_access_denied") {
    return tx("你取消了 Dofe SSO 登录。", "You cancelled Dofe SSO sign-in.");
  }
  if (message === "auth.sso_state_invalid" || message === "auth.sso_id_token_invalid") {
    return tx("Dofe SSO 登录状态校验失败，请重试。", "Dofe SSO sign-in verification failed. Please try again.");
  }
  if (message === "auth.sso_email_not_verified") {
    return tx("Dofe SSO 账户的邮箱尚未验证。", "Your Dofe SSO account email is not verified.");
  }
  if (message === "auth.sso_profile_missing_email") {
    return tx("Dofe SSO 未返回可用邮箱。", "Dofe SSO did not return a usable email address.");
  }
  if (message === "auth.sso_profile_managed") {
    return tx("账号资料由 Dofe SSO 管理。", "Account details are managed by Dofe SSO.");
  }
  if (message === "auth.sso_user_inactive") {
    return tx("该 Dofe SSO 账户已停用。", "This Dofe SSO account is inactive.");
  }
  if (message === "auth.sso_no_workspace" || message === "auth.sso_workspace_managed") {
    return tx("工作区与成员资格由 Dofe SSO 管理，请在 SSO 中加入租户或团队后重新登录。", "Workspaces and memberships are managed by Dofe SSO. Join a tenant or team in SSO, then sign in again.");
  }
  if (message.startsWith("auth.sso_")) {
    return tx("Dofe SSO 登录失败，请稍后重试。", "Dofe SSO sign-in failed. Please try again.");
  }
  if (message === "workspace.invitation.invalid" || message === "workspace.invitation.inactive") {
    return tx("邀请链接无效。", "Invitation link is invalid.");
  }
  if (message === "workspace.invitation.expired") {
    return tx("邀请已过期。", "Invitation has expired.");
  }
  if (message === "workspace.invitation.email_mismatch") {
    return tx("当前账号邮箱与邀请邮箱不一致。", "This account email does not match the invitation email.");
  }
  if (message === "workspace.join_code.invalid") {
    return tx("邀请码无效或已重置。", "This invite code is invalid or has been reset.");
  }
  if (message === "workspace.join_code.missing") {
    return tx("请填写工作区邀请码。", "Please enter a workspace invite code.");
  }
  if (message === "Missing form value \"displayName\".") {
    return tx("请填写你的名字。", "Please enter your name.");
  }
  if (message === "Missing form value \"workspaceName\".") {
    return tx("请填写工作区名字。", "Please enter a workspace name.");
  }
  if (message === "Missing form value \"email\".") {
    return tx("请填写邮箱。", "Please enter your email.");
  }
  if (message === "Missing form value \"password\".") {
    return tx("请填写密码。", "Please enter your password.");
  }
  if (message.startsWith("Missing form value")) {
    return tx("表单信息不完整，请检查后重试。", "The form is incomplete. Please review it and try again.");
  }
  return message;
}
