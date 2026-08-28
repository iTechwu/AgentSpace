import { revalidatePath } from "next/cache";
import { buildWorkspacePath } from "./workspace-paths";

export function revalidateWorkspacePath(path: string, workspaceSlug: string): void {
  revalidatePath(path);
  revalidatePath(buildWorkspacePath(workspaceSlug, path));
}

export function revalidateWorkspacePaths(workspaceSlug: string, paths: string[]): void {
  for (const path of paths) {
    revalidateWorkspacePath(path, workspaceSlug);
  }
}
