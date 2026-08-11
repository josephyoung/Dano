import * as fs from "node:fs";
import * as path from "node:path";
import {
  createDanoBackend,
  type CreateDanoBackendOptions,
  type DanoBackend,
} from "../backend.js";
import type { AuthenticatedUserContext } from "./user-context.js";
import { workspaceSessionDirectoryPath } from "./runtime-layout.js";
import { ensureSafeDirectory } from "./safe-directory.js";

export interface UserRuntimeContext {
  readonly userId: string;
  readonly backend: DanoBackend;
  readonly defaultWorkspacePath: string;
  readonly sessionsRootPath: string;
  ownsSessionPath(candidatePath: string): boolean;
  ownsWorkspacePath(candidatePath: string): boolean;
}

export type UserBackendFactory = (
  options: CreateDanoBackendOptions,
) => Promise<DanoBackend>;

export class UserRuntimeRegistry {
  private readonly contexts = new Map<
    string,
    Promise<UserRuntimeContext>
  >();

  constructor(
    private readonly createBackend: UserBackendFactory = createDanoBackend,
  ) {}

  get(userContext: AuthenticatedUserContext): Promise<UserRuntimeContext> {
    const existing = this.contexts.get(userContext.user.id);
    if (existing) return existing;

    const creating = this.create(userContext).catch(error => {
      this.contexts.delete(userContext.user.id);
      throw error;
    });
    this.contexts.set(userContext.user.id, creating);
    return creating;
  }

  async dispose(): Promise<void> {
    const contexts = [...this.contexts.values()];
    this.contexts.clear();
    const settled = await Promise.allSettled(contexts);
    await Promise.all(
      settled.flatMap(result =>
        result.status === "fulfilled" ? [result.value.backend.dispose()] : [],
      ),
    );
  }

  private async create(
    userContext: AuthenticatedUserContext,
  ): Promise<UserRuntimeContext> {
    const workspaceRootPath = path.join(userContext.folderPath, "workspaces");
    const defaultWorkspacePath = path.join(workspaceRootPath, "default");
    const sessionsRootPath = path.join(userContext.folderPath, "sessions");
    const unsafeRuntimeDirectory = () =>
      new Error("User runtime path is not a safe directory");
    await ensureSafeDirectory(workspaceRootPath, {
      recursive: true,
      unsafeDirectoryError: unsafeRuntimeDirectory,
    });
    await ensureSafeDirectory(defaultWorkspacePath, {
      unsafeDirectoryError: unsafeRuntimeDirectory,
    });
    await ensureSafeDirectory(sessionsRootPath, {
      unsafeDirectoryError: unsafeRuntimeDirectory,
    });
    const backend = await this.createBackend({
      cwd: defaultWorkspacePath,
      sessionDir: workspaceSessionDirectoryPath(
        sessionsRootPath,
        defaultWorkspacePath,
      ),
    });
    return {
      userId: userContext.user.id,
      backend,
      defaultWorkspacePath,
      sessionsRootPath,
      ownsSessionPath: candidatePath =>
        isOwnedRuntimePath(sessionsRootPath, candidatePath),
      ownsWorkspacePath: candidatePath =>
        isOwnedRuntimePath(workspaceRootPath, candidatePath),
    };
  }
}

function isOwnedRuntimePath(rootPath: string, candidatePath: string): boolean {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.resolve(candidatePath);
  if (!isPathInsideRoot(resolvedRoot, resolvedCandidate)) return false;

  try {
    const realRoot = fs.realpathSync.native(resolvedRoot);
    let existingPath = resolvedCandidate;
    while (!fs.existsSync(existingPath) && existingPath !== resolvedRoot) {
      existingPath = path.dirname(existingPath);
    }
    return isPathInsideRoot(
      realRoot,
      fs.realpathSync.native(existingPath),
    );
  } catch {
    return false;
  }
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  return (
    candidatePath === rootPath ||
    candidatePath.startsWith(`${rootPath}${path.sep}`)
  );
}
