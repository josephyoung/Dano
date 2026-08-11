import * as path from "node:path";

export function workspaceSessionDirectoryName(workspacePath: string): string {
  return `--${workspacePath.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

export function workspaceSessionDirectoryPath(
  sessionsRootPath: string,
  workspacePath: string,
): string {
  return path.join(
    sessionsRootPath,
    workspaceSessionDirectoryName(workspacePath),
  );
}
