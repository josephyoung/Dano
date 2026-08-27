import { DANO_SESSION_PERSISTENCE_ERROR } from "./types.js";

const SESSION_PERSISTENCE_ERROR_CODES = new Set([
  "EACCES",
  "EDQUOT",
  "EIO",
  "EMFILE",
  "ENFILE",
  "ENOSPC",
  "EPERM",
  "EROFS",
]);

export function commandErrorMessage(
  commandType: string,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (commandType !== "prompt") return message;

  return isSessionPersistenceError(error)
    ? DANO_SESSION_PERSISTENCE_ERROR
    : message;
}

export function isSessionPersistenceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
  const hasPersistenceContext =
    /\.jsonl\b/i.test(message) ||
    (error !== null &&
      typeof error === "object" &&
      (("path" in error && typeof error.path === "string") ||
        ("syscall" in error &&
          /^(?:appendFile|open|rename|write|writeFile)$/.test(
            String(error.syscall),
          ))));
  if (
    hasPersistenceContext &&
    ((code && SESSION_PERSISTENCE_ERROR_CODES.has(code)) ||
      /\b(?:EACCES|EDQUOT|EIO|EMFILE|ENFILE|ENOSPC|EPERM|EROFS)\b/.test(message))
  ) {
    return true;
  }

  return false;
}
