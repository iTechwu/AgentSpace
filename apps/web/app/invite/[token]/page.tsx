import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function InvitationPage() {
  redirect("/auth/error?code=auth.sso_workspace_managed");
}
