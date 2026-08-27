import * as path from "node:path";
import { DANO_SESSION_PERSISTENCE_ERROR } from "./types.js";

const SESSION_PERSISTENCE_ERROR_CODES = new Set([
  "EACCES",
  "EDQUOT",
  "EIO",
  "EISDIR",
  "EMFILE",
  "ENOENT",
  "ENFILE",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
]);

export class SessionPersistenceError extends Error {
  readonly code = DANO_SESSION_PERSISTENCE_ERROR;

  constructor(cause: unknown) {
    super("Session persistence failed", { cause });
    this.name = "SessionPersistenceError";
  }
}

export function commandErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof SessionPersistenceError
    ? DANO_SESSION_PERSISTENCE_ERROR
    : message;
}

export function wrapSessionPersistenceError(
  error: unknown,
  sessionPath: string | null | undefined,
): unknown {
  if (!sessionPath || error instanceof SessionPersistenceError) return error;
  const expectedPath = path.resolve(sessionPath);
  const visited = new WeakSet<object>();

  for (let candidate: unknown = error; candidate; ) {
    if (candidate instanceof SessionPersistenceError) return candidate;
    if (typeof candidate !== "object") break;
    if (visited.has(candidate)) break;
    visited.add(candidate);
    const record = candidate as {
      code?: unknown;
      path?: unknown;
      syscall?: unknown;
      cause?: unknown;
    };
    if (
      typeof record.code === "string" &&
      SESSION_PERSISTENCE_ERROR_CODES.has(record.code) &&
      ((record.path === undefined && record.syscall === "write") ||
        (typeof record.path === "string" &&
          path.resolve(record.path) === expectedPath))
    ) {
      return new SessionPersistenceError(error);
    }
    candidate = record.cause;
  }
  return error;
}
