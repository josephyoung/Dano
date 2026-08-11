import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import * as path from "node:path";
import { ensureSafeDirectory } from "./safe-directory.js";
import {
  ensureUserFolder,
  toBrowserUserSummary,
  type AuthenticatedUserContext,
  type AuthenticatedUserContextResolver,
  type ClientUserResolution,
  type UserContext,
  type UserContextResolver,
} from "./user-context.js";

const DEFAULT_GUEST_COOKIE_NAME = "dano_guest";
const OPAQUE_GUEST_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface StoredGuestSession {
  readonly userId: string;
}

export interface AnonymousUserContextResolverOptions {
  readonly runtimeRootPath: string;
  readonly authenticatedResolver?: AuthenticatedUserContextResolver;
  readonly cookieName?: string;
  readonly secureCookie: boolean;
}

export function createAnonymousUserContextResolver(
  options: AnonymousUserContextResolverOptions,
): UserContextResolver {
  const cookieName = options.cookieName?.trim() || DEFAULT_GUEST_COOKIE_NAME;
  const usersRootPath = path.resolve(options.runtimeRootPath, "users");
  const sessionsRootPath = path.resolve(
    options.runtimeRootPath,
    "anonymous-sessions",
  );

  const resolveGuest = async (
    headers: IncomingHttpHeaders,
  ): Promise<UserContext | null> => {
    const guestId = readCookie(headers, cookieName);
    if (!guestId || !OPAQUE_GUEST_ID_PATTERN.test(guestId)) return null;
    const stored = await readStoredSession(sessionsRootPath, guestId);
    if (!stored) return null;
    return {
      user: { id: stored.userId },
      folderPath: await ensureUserFolder(usersRootPath, stored.userId),
    };
  };

  return {
    async resolve(headers) {
      const authenticated = await options.authenticatedResolver?.resolve(headers);
      return authenticated ?? resolveGuest(headers);
    },

    async resolveForClient(headers) {
      const authenticated = await options.authenticatedResolver?.resolve(headers);
      if (authenticated) return authenticatedResolution(authenticated);

      const guest = await resolveGuest(headers);
      if (guest) {
        return { userContext: guest, authentication: { status: "anonymous" } };
      }

      const created = await createGuestSession(sessionsRootPath, usersRootPath);
      return {
        userContext: created.userContext,
        authentication: { status: "anonymous" },
        setCookie: serializeGuestCookie(
          cookieName,
          created.guestId,
          options.secureCookie,
        ),
      };
    },
  };
}

function authenticatedResolution(
  userContext: AuthenticatedUserContext,
): ClientUserResolution {
  const user = userContext.user;
  return {
    userContext,
    authentication: {
      status: "authenticated",
      user: toBrowserUserSummary(user),
    },
  };
}

async function createGuestSession(
  sessionsRootPath: string,
  usersRootPath: string,
): Promise<{ guestId: string; userContext: UserContext }> {
  await ensureSafeDirectory(sessionsRootPath, {
    recursive: true,
    unsafeDirectoryError: () =>
      new Error("Anonymous sessions root is not a safe directory"),
  });
  const guestId = randomBytes(32).toString("base64url");
  const userId = `anonymous_${randomBytes(24).toString("hex")}`;
  const recordPath = guestSessionPath(sessionsRootPath, guestId);
  await fs.promises.writeFile(
    recordPath,
    `${JSON.stringify({ userId } satisfies StoredGuestSession)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return {
    guestId,
    userContext: {
      user: { id: userId },
      folderPath: await ensureUserFolder(usersRootPath, userId),
    },
  };
}

async function readStoredSession(
  sessionsRootPath: string,
  guestId: string,
): Promise<StoredGuestSession | null> {
  try {
    const value = JSON.parse(
      await fs.promises.readFile(
        guestSessionPath(sessionsRootPath, guestId),
        "utf8",
      ),
    ) as unknown;
    if (!isStoredGuestSession(value)) return null;
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function isStoredGuestSession(value: unknown): value is StoredGuestSession {
  return (
    typeof value === "object" &&
    value !== null &&
    "userId" in value &&
    typeof value.userId === "string" &&
    /^anonymous_[a-f0-9]{48}$/.test(value.userId)
  );
}

function guestSessionPath(sessionsRootPath: string, guestId: string): string {
  const key = createHash("sha256").update(guestId).digest("hex");
  return path.join(sessionsRootPath, `${key}.json`);
}

function readCookie(
  headers: IncomingHttpHeaders,
  cookieName: string,
): string | null {
  for (const pair of headers.cookie?.split(";") ?? []) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== cookieName) continue;
    const value = pair.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

function serializeGuestCookie(
  cookieName: string,
  guestId: string,
  secure: boolean,
): string {
  return [
    `${cookieName}=${encodeURIComponent(guestId)}`,
    "Path=/",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Lax",
  ].join("; ");
}
