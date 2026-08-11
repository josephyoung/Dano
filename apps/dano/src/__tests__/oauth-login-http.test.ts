import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnonymousUserContextResolver } from "../bridge/anonymous-user-context.js";
import {
  createOAuthAuthentication,
  type OAuthAuthenticationOptions,
  type OAuthProviderAdapter,
} from "../bridge/oauth-authentication.js";
import { createOAuth2ProviderAdapter } from "../bridge/oauth-provider.js";
import {
  DEFAULT_BRIDGE_CONFIG,
  type ClientMessage,
  type ServerMessage,
} from "../bridge/types.js";
import { startDanoServer, type DanoServerController } from "../server.js";

const controllers: DanoServerController[] = [];
const authentications: Array<{ dispose(): Promise<void> }> = [];
const runtimeRoots: string[] = [];
const providerServers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.stop()));
  await Promise.all(
    authentications.splice(0).map(authentication => authentication.dispose()),
  );
  for (const root of runtimeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  await Promise.all(
    providerServers.splice(0).map(
      server =>
        new Promise<void>(resolve => server.close(() => resolve())),
    ),
  );
});

async function startOAuthServer(
  provider: OAuthProviderAdapter,
  existingRuntimeRootPath?: string,
  overrides: Partial<
    Pick<
      OAuthAuthenticationOptions,
      | "credentialEncryptionKey"
      | "maxPendingTransactions"
      | "now"
      | "sessionGcIntervalMs"
      | "stateTtlMs"
    >
  > = {},
  anonymousCleanup?: {
    idleTtlMs: number;
    intervalMs: number;
    now: () => number;
  },
) {
  const runtimeRootPath =
    existingRuntimeRootPath ??
    fs.mkdtempSync(path.join(os.tmpdir(), "dano-oauth-http-"));
  if (!existingRuntimeRootPath) runtimeRoots.push(runtimeRootPath);
  const authentication = await createOAuthAuthentication({
    runtimeRootPath,
    appOrigin: "https://dano.example.test",
    redirectUri: "https://dano.example.test/api/auth/callback",
    provider,
    credentialEncryptionKey: {
      version: "test-v1",
      key: Buffer.alloc(32, 7),
    },
    ...overrides,
  });
  authentications.push(authentication);
  const anonymousUsers = createAnonymousUserContextResolver({
    runtimeRootPath,
    secureCookie: false,
    authenticatedResolver: authentication,
    now: anonymousCleanup?.now,
    activityWriteIntervalMs: anonymousCleanup
      ? Math.max(1, Math.floor(anonymousCleanup.idleTtlMs / 2))
      : undefined,
  });
  const controller = await startDanoServer(
    {
      ...DEFAULT_BRIDGE_CONFIG,
      host: "127.0.0.1",
      port: 0,
      upload: {
        ...DEFAULT_BRIDGE_CONFIG.upload,
        uploadDir: path.join(runtimeRootPath, "uploads"),
      },
    },
    {
      captureSigint: false,
      userContextResolver: anonymousUsers,
      ...(anonymousCleanup
        ? {
            anonymousUsers,
            anonymousUserCleanup: anonymousCleanup,
          }
        : {}),
      authHttpHandler: authentication,
    },
  );
  controllers.push(controller);
  const origin = controller.getBridgeUrl();
  if (!origin) throw new Error("Dano OAuth test server did not start");
  return { authentication, controller, origin, runtimeRootPath };
}

function cookieFrom(response: Response, name: string): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error(`Expected ${name} Cookie`);
  const pair = setCookie.split(";", 1)[0];
  if (!pair?.startsWith(`${name}=`)) {
    throw new Error(`Expected ${name} Cookie`);
  }
  return pair;
}

async function startFakeProvider(options: {
  tokenDelayMs?: number;
  tokenStatus?: number;
  tokenResponse?: unknown | ((request: URLSearchParams) => unknown);
  identity?: unknown;
} = {}) {
  const tokenRequests: URLSearchParams[] = [];
  const identityAuthorization: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/token") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", chunk => (body += chunk));
      req.on("end", () => {
        tokenRequests.push(new URLSearchParams(body));
        setTimeout(() => {
          res.writeHead(options.tokenStatus ?? 200, {
            "Content-Type": "application/json",
          });
          res.end(
            JSON.stringify(
              (typeof options.tokenResponse === "function"
                ? options.tokenResponse(tokenRequests.at(-1)!)
                : options.tokenResponse) ?? {
                access_token: "fake-access-token",
                refresh_token: "fake-refresh-token",
                token_type: "Bearer",
                expires_in: 3600,
              },
            ),
          );
        }, options.tokenDelayMs ?? 0);
      });
      return;
    }
    if (req.method === "GET" && req.url === "/identity") {
      identityAuthorization.push(req.headers.authorization ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          options.identity ?? {
            userId: "fake-provider-user",
            displayName: "Fake Provider User",
          },
        ),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  providerServers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake provider did not start");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    tokenRequests,
    identityAuthorization,
  };
}

describe("OAuth authentication over HTTP", () => {
  it("projects an Anonymous User from /api/auth/current without a Login Session", async () => {
    const provider: OAuthProviderAdapter = {
      authorizationUrl() {
        throw new Error("not used");
      },
      async exchangeAuthorizationCode() {
        throw new Error("not used");
      },
    };
    const { origin, runtimeRootPath } = await startOAuthServer(provider);

    const response = await fetch(`${origin}/api/auth/current`);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "anonymous" });
  });

  it("starts a browser-bound login with a strong one-time state and fixed redirect URI", async () => {
    const authorizationInputs: Array<{ state: string; redirectUri: string }> = [];
    const provider: OAuthProviderAdapter = {
      authorizationUrl(input) {
        authorizationInputs.push(input);
        const url = new URL("https://provider.example.test/authorize");
        url.searchParams.set("response_type", "code");
        url.searchParams.set("state", input.state);
        url.searchParams.set("redirect_uri", input.redirectUri);
        return url;
      },
      async exchangeAuthorizationCode() {
        throw new Error("not used");
      },
    };
    const { origin } = await startOAuthServer(provider);

    const response = await fetch(
      `${origin}/api/auth/login?returnTo=${encodeURIComponent("/chat?session=one")}`,
      { redirect: "manual" },
    );

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://provider.example.test");
    expect(location.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://dano.example.test/api/auth/callback",
    );
    expect(location.searchParams.has("code_challenge")).toBe(false);
    expect(authorizationInputs).toEqual([
      {
        state: location.searchParams.get("state"),
        redirectUri: "https://dano.example.test/api/auth/callback",
      },
    ]);
    expect(response.headers.get("set-cookie")).toMatch(
      /^dano_oauth_flow=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("atomically creates a persistent opaque Login Session and projects only External Identity", async () => {
    const exchanges: Array<{
      code: string;
      state: string;
      redirectUri: string;
    }> = [];
    const provider: OAuthProviderAdapter = {
      authorizationUrl(input) {
        const url = new URL("https://provider.example.test/authorize");
        url.searchParams.set("state", input.state);
        url.searchParams.set("redirect_uri", input.redirectUri);
        return url;
      },
      async exchangeAuthorizationCode(input) {
        exchanges.push(input);
        return {
          identity: {
            userId: "opaque/external/user",
            displayName: "Example User",
            avatarUrl: "https://images.example.test/avatar.png",
          },
          credential: {
            accessToken: "fixture-access-secret",
            refreshToken: "fixture-refresh-secret",
            tokenType: "Bearer",
            expiresAt: 2_000_000_000_000,
          },
        };
      },
    };
    const firstServer = await startOAuthServer(provider);
    const started = await fetch(`${firstServer.origin}/api/auth/login?returnTo=/chat`, {
      redirect: "manual",
    });
    const flowCookie = cookieFrom(started, "dano_oauth_flow");
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;

    const callback = await fetch(
      `${firstServer.origin}/api/auth/callback?code=fixture-code&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: flowCookie }, redirect: "manual" },
    );

    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("/chat");
    expect(callback.headers.get("cache-control")).toBe("no-store");
    expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
    expect(callback.headers.get("set-cookie")).toMatch(
      /^dano_login=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800$/,
    );
    expect(exchanges).toEqual([
      {
        code: "fixture-code",
        state,
        redirectUri: "https://dano.example.test/api/auth/callback",
      },
    ]);

    const loginCookie = cookieFrom(callback, "dano_login");
    const current = await fetch(`${firstServer.origin}/api/auth/current`, {
      headers: { Cookie: loginCookie },
    });
    expect(await current.json()).toEqual({
      status: "authenticated",
      user: {
        username: "Example User",
        avatarUrl: "https://images.example.test/avatar.png",
      },
    });
    const currentText = await (
      await fetch(`${firstServer.origin}/api/auth/current`, {
        headers: { Cookie: loginCookie },
      })
    ).text();
    expect(currentText).not.toContain("opaque/external/user");
    expect(currentText).not.toContain("fixture-access-secret");
    expect(currentText).not.toContain("fixture-refresh-secret");

    const persisted = fs
      .readdirSync(firstServer.runtimeRootPath, {
        recursive: true,
        encoding: "utf8",
      })
      .filter(entry => entry.endsWith(".json"))
      .map(entry =>
        fs.readFileSync(path.join(firstServer.runtimeRootPath, entry), "utf8"),
      )
      .join("\n");
    expect(persisted).not.toContain("fixture-access-secret");
    expect(persisted).not.toContain("fixture-refresh-secret");

    await firstServer.controller.stop();
    await firstServer.authentication.dispose();
    const restarted = await startOAuthServer(
      provider,
      firstServer.runtimeRootPath,
    );
    const restored = await fetch(`${restarted.origin}/api/auth/current`, {
      headers: { Cookie: loginCookie },
    });
    expect(await restored.json()).toMatchObject({ status: "authenticated" });
  });

  it("uses openid-client for the confidential Authorization Code exchange without PKCE", async () => {
    const fakeProvider = await startFakeProvider();
    const provider = createOAuth2ProviderAdapter({
      issuer: fakeProvider.origin,
      authorizationEndpoint: `${fakeProvider.origin}/authorize`,
      tokenEndpoint: `${fakeProvider.origin}/token`,
      identityEndpoint: `${fakeProvider.origin}/identity`,
      clientId: "fake-client",
      clientSecret: "fake-client-secret",
      scope: "profile offline_access",
      allowInsecureRequests: true,
    });
    const { origin } = await startOAuthServer(provider);
    const started = await fetch(`${origin}/api/auth/login`, {
      redirect: "manual",
    });
    const authorizationUrl = new URL(started.headers.get("location")!);
    const state = authorizationUrl.searchParams.get("state")!;
    expect(authorizationUrl.searchParams.get("client_id")).toBe("fake-client");
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "profile offline_access",
    );
    expect(authorizationUrl.searchParams.has("code_challenge")).toBe(false);

    const callback = await fetch(
      `${origin}/api/auth/callback?code=fake-code&state=${encodeURIComponent(state)}`,
      {
        headers: { Cookie: cookieFrom(started, "dano_oauth_flow") },
        redirect: "manual",
      },
    );

    expect(callback.status).toBe(303);
    expect(cookieFrom(callback, "dano_login")).toMatch(/^dano_login=/);
    expect(fakeProvider.tokenRequests).toHaveLength(1);
    expect(fakeProvider.tokenRequests[0]?.get("grant_type")).toBe(
      "authorization_code",
    );
    expect(fakeProvider.tokenRequests[0]?.get("code")).toBe("fake-code");
    expect(fakeProvider.tokenRequests[0]?.get("redirect_uri")).toBe(
      "https://dano.example.test/api/auth/callback",
    );
    expect(fakeProvider.tokenRequests[0]?.has("code_verifier")).toBe(false);
    expect(fakeProvider.tokenRequests[0]?.get("client_id")).toBe("fake-client");
    expect(fakeProvider.tokenRequests[0]?.get("client_secret")).toBe(
      "fake-client-secret",
    );
    expect(fakeProvider.identityAuthorization).toEqual([
      "Bearer fake-access-token",
    ]);
  });

  it("uses openid-client to refresh and retains a refresh token omitted during rotation", async () => {
    const fakeProvider = await startFakeProvider({
      tokenResponse(request: URLSearchParams) {
        return request.get("grant_type") === "refresh_token"
          ? {
              access_token: "renewed-access-token",
              token_type: "Bearer",
              expires_in: 1800,
            }
          : {
              access_token: "initial-access-token",
              refresh_token: "initial-refresh-token",
              token_type: "Bearer",
              expires_in: 3600,
            };
      },
    });
    const provider = createOAuth2ProviderAdapter({
      issuer: fakeProvider.origin,
      authorizationEndpoint: `${fakeProvider.origin}/authorize`,
      tokenEndpoint: `${fakeProvider.origin}/token`,
      identityEndpoint: `${fakeProvider.origin}/identity`,
      clientId: "fake-client",
      clientSecret: "fake-client-secret",
      scope: "profile offline_access",
      allowInsecureRequests: true,
    });

    const refreshed = await provider.refreshCredential?.({
      accessToken: "expired-access-token",
      refreshToken: "initial-refresh-token",
      tokenType: "Bearer",
    });

    expect(fakeProvider.tokenRequests).toHaveLength(1);
    expect(fakeProvider.tokenRequests[0]?.get("grant_type")).toBe("refresh_token");
    expect(fakeProvider.tokenRequests[0]?.get("refresh_token")).toBe(
      "initial-refresh-token",
    );
    expect(refreshed).toMatchObject({
      accessToken: "renewed-access-token",
      refreshToken: "initial-refresh-token",
      tokenType: "bearer",
    });
  });

  it("atomically consumes state and rejects replay or another browser binding", async () => {
    let exchanges = 0;
    const provider: OAuthProviderAdapter = {
      authorizationUrl(input) {
        const url = new URL("https://provider.example.test/authorize");
        url.searchParams.set("state", input.state);
        return url;
      },
      async exchangeAuthorizationCode() {
        exchanges += 1;
        return {
          identity: { userId: "state-user" },
          credential: { accessToken: "state-access" },
        };
      },
    };
    const { origin } = await startOAuthServer(provider);
    const first = await fetch(`${origin}/api/auth/login`, { redirect: "manual" });
    const firstState = new URL(first.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const firstFlowCookie = cookieFrom(first, "dano_oauth_flow");
    const wrongBrowser = await fetch(
      `${origin}/api/auth/callback?code=wrong-browser&state=${firstState}`,
      {
        headers: { Cookie: `dano_oauth_flow=${"A".repeat(43)}` },
        redirect: "manual",
      },
    );
    expect(wrongBrowser.headers.get("set-cookie")).toBeNull();
    expect(exchanges).toBe(0);

    const second = await fetch(`${origin}/api/auth/login`, {
      headers: { Cookie: firstFlowCookie },
      redirect: "manual",
    });
    const secondState = new URL(second.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const accepted = await fetch(
      `${origin}/api/auth/callback?code=accepted&state=${secondState}`,
      { headers: { Cookie: firstFlowCookie }, redirect: "manual" },
    );
    expect(cookieFrom(accepted, "dano_login")).toMatch(/^dano_login=/);
    const replay = await fetch(
      `${origin}/api/auth/callback?code=replay&state=${secondState}`,
      { headers: { Cookie: firstFlowCookie }, redirect: "manual" },
    );
    expect(replay.headers.get("set-cookie")).toBeNull();
    expect(exchanges).toBe(1);
  });

  it("expires short-lived state using the configured clock", async () => {
    let currentTime = 10_000;
    let exchanges = 0;
    const provider: OAuthProviderAdapter = {
      authorizationUrl(input) {
        const url = new URL("https://provider.example.test/authorize");
        url.searchParams.set("state", input.state);
        return url;
      },
      async exchangeAuthorizationCode() {
        exchanges += 1;
        throw new Error("expired state must not reach provider");
      },
    };
    const { origin } = await startOAuthServer(provider, undefined, {
      now: () => currentTime,
      stateTtlMs: 1_000,
    });
    const started = await fetch(`${origin}/api/auth/login`, {
      redirect: "manual",
    });
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;
    currentTime += 1_000;

    const callback = await fetch(
      `${origin}/api/auth/callback?code=late&state=${state}`,
      {
        headers: { Cookie: cookieFrom(started, "dano_oauth_flow") },
        redirect: "manual",
      },
    );

    expect(callback.headers.get("set-cookie")).toBeNull();
    expect(exchanges).toBe(0);
  });

  it("limits parallel login transactions for one browser", async () => {
    const provider: OAuthProviderAdapter = {
      authorizationUrl(input) {
        const url = new URL("https://provider.example.test/authorize");
        url.searchParams.set("state", input.state);
        return url;
      },
      async exchangeAuthorizationCode() {
        throw new Error("not used");
      },
    };
    const { origin } = await startOAuthServer(provider, undefined, {
      maxPendingTransactions: 2,
    });
    const first = await fetch(`${origin}/api/auth/login`, { redirect: "manual" });
    const flowCookie = cookieFrom(first, "dano_oauth_flow");
    const second = await fetch(`${origin}/api/auth/login`, {
      headers: { Cookie: flowCookie },
      redirect: "manual",
    });
    const blocked = await fetch(`${origin}/api/auth/login`, {
      headers: { Cookie: flowCookie },
      redirect: "manual",
    });

    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(blocked.status).toBe(429);
  });

  it("binds login state to the existing Anonymous User browser Cookie", async () => {
    const provider = successfulProvider("guest-bound-user", "guest-bound-token");
    const { origin } = await startOAuthServer(provider);
    const anonymous = await fetch(`${origin}/api/clients`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const guestCookie = cookieFrom(anonymous, "dano_guest");

    const started = await fetch(`${origin}/api/auth/login`, {
      headers: { Cookie: guestCookie },
      redirect: "manual",
    });
    expect(started.headers.get("set-cookie")).toBeNull();
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const callback = await fetch(
      `${origin}/api/auth/callback?code=fixture&state=${state}`,
      { headers: { Cookie: guestCookie }, redirect: "manual" },
    );

    expect(cookieFrom(callback, "dano_login")).toMatch(/^dano_login=/);
  });

  it("atomically transfers only the callback-bound Anonymous User data before login", async () => {
    let now = 1_000;
    const provider = successfulProvider("transfer-owner", "transfer-token");
    const { origin } = await startOAuthServer(provider, undefined, {}, {
      idleTtlMs: 1_000,
      intervalMs: 10,
      now: () => now,
    });
    const anonymous = await fetch(`${origin}/api/clients`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const anonymousBody = (await anonymous.json()) as {
      client: { id: string };
      defaultWorkspacePath: string;
    };
    const guestCookie = cookieFrom(anonymous, "dano_guest");
    fs.writeFileSync(
      path.join(anonymousBody.defaultWorkspacePath, "guest-note.txt"),
      "owned by the callback guest",
      "utf8",
    );
    const savedPreference = await fetch(
      `${origin}/api/clients/${anonymousBody.client.id}/preferences/theme`,
      {
        method: "PUT",
        headers: {
          Cookie: guestCookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ accentColorPreset: "purple" }),
      },
    );
    expect(savedPreference.status).toBe(200);

    const started = await fetch(`${origin}/api/auth/login?returnTo=/chat`, {
      headers: { Cookie: guestCookie },
      redirect: "manual",
    });
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const callback = await fetch(
      `${origin}/api/auth/callback?code=fixture&state=${state}`,
      { headers: { Cookie: guestCookie }, redirect: "manual" },
    );
    const loginCookie = cookieFrom(callback, "dano_login");
    const authenticated = await fetch(`${origin}/api/clients`, {
      method: "POST",
      headers: { Cookie: loginCookie, "Content-Type": "application/json" },
      body: "{}",
    });
    const authenticatedBody = (await authenticated.json()) as {
      client: { id: string };
      defaultWorkspacePath: string;
    };

    expect(authenticated.status).toBe(201);
    expect(
      fs.readFileSync(
        path.join(authenticatedBody.defaultWorkspacePath, "guest-note.txt"),
        "utf8",
      ),
    ).toBe("owned by the callback guest");
    const transferredPreference = await fetch(
      `${origin}/api/clients/${authenticatedBody.client.id}/preferences/theme`,
      { headers: { Cookie: loginCookie } },
    );
    expect(await transferredPreference.json()).toEqual({
      accentColorPreset: "purple",
    });

    const staleGuest = await fetch(`${origin}/api/clients`, {
      method: "POST",
      headers: { Cookie: guestCookie, "Content-Type": "application/json" },
      body: "{}",
    });
    const staleGuestBody = (await staleGuest.json()) as {
      client: { id: string };
      defaultWorkspacePath: string;
    };
    expect(staleGuest.headers.get("set-cookie")).toMatch(/^dano_guest=/);
    expect(staleGuestBody.defaultWorkspacePath).not.toBe(
      authenticatedBody.defaultWorkspacePath,
    );
    expect(
      fs.existsSync(path.join(staleGuestBody.defaultWorkspacePath, "guest-note.txt")),
    ).toBe(false);
    await fetch(
      `${origin}/api/clients/${authenticatedBody.client.id}/disconnect`,
      { method: "POST", headers: { Cookie: loginCookie }, body: "{}" },
    );
    const replacementGuestCookie = cookieFrom(staleGuest, "dano_guest");
    await fetch(`${origin}/api/clients/${staleGuestBody.client.id}/disconnect`, {
      method: "POST",
      headers: { Cookie: replacementGuestCookie },
      body: "{}",
    });
    now = 2_001;
    await vi.waitFor(
      () =>
        expect(fs.existsSync(staleGuestBody.defaultWorkspacePath)).toBe(false),
      { timeout: 2_000, interval: 10 },
    );
    expect(
      fs.readFileSync(
        path.join(authenticatedBody.defaultWorkspacePath, "guest-note.txt"),
        "utf8",
      ),
    ).toBe("owned by the callback guest");
  });

  it("rolls back a failed Anonymous User transfer and keeps the guest usable", async () => {
    const externalUserId = "rollback-owner";
    const revoked: string[] = [];
    const provider: OAuthProviderAdapter = {
      ...successfulProvider(externalUserId, "rollback-token"),
      async revokeCredential(credential) {
        revoked.push(credential.accessToken);
      },
    };
    const { origin, runtimeRootPath } = await startOAuthServer(provider);
    const anonymous = await fetch(`${origin}/api/clients`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const anonymousBody = (await anonymous.json()) as {
      client: { id: string };
      defaultWorkspacePath: string;
    };
    const guestCookie = cookieFrom(anonymous, "dano_guest");
    const retainedPath = path.join(
      anonymousBody.defaultWorkspacePath,
      "a-retained.txt",
    );
    fs.writeFileSync(retainedPath, "guest remains owner", "utf8");
    const unavailableUpload = await uploadProjectFile(
      origin,
      anonymousBody as TestBridgeClient,
      guestCookie,
      "unavailable.txt",
      "removed before owner transfer",
    );
    fs.rmSync(unavailableUpload.path);
    const started = await fetch(`${origin}/api/auth/login`, {
      headers: { Cookie: guestCookie },
      redirect: "manual",
    });
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;

    const callback = await fetch(
      `${origin}/api/auth/callback?code=fixture&state=${state}`,
      { headers: { Cookie: guestCookie }, redirect: "manual" },
    );

    expect(callback.headers.get("set-cookie")).toBeNull();
    expect(revoked).toEqual(["rollback-token"]);
    expect(
      fs.readdirSync(path.join(runtimeRootPath, "auth", "login-sessions")),
    ).toEqual([]);
    expect(fs.readFileSync(retainedPath, "utf8")).toBe("guest remains owner");
    const canonicalUserId = `oauth_${createHash("sha256")
      .update(externalUserId)
      .digest("hex")}`;
    expect(
      fs.existsSync(
        path.join(
          runtimeRootPath,
          "users",
          canonicalUserId,
          "workspaces",
          "default",
          "a-retained.txt",
        ),
      ),
    ).toBe(false);
    expect(
      (
        await fetch(
          `${origin}/api/clients/${anonymousBody.client.id}/preferences/theme`,
          { headers: { Cookie: guestCookie } },
        )
      ).status,
    ).toBe(200);
  });

  it("merges guest sessions without replacing an authenticated User's existing data", async () => {
    const provider = successfulProvider("merge-owner", "merge-token");
    const { origin, runtimeRootPath } = await startOAuthServer(provider);
    const existingLoginCookie = await completeLogin(origin, "existing-login");
    const existingClient = await createAuthenticatedClient(
      origin,
      existingLoginCookie,
    );
    expect(
      (
        await fetch(
          `${origin}/api/clients/${existingClient.client.id}/preferences/theme`,
          {
            method: "PUT",
            headers: {
              Cookie: existingLoginCookie,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ accentColorPreset: "blue" }),
          },
        )
      ).status,
    ).toBe(200);
    fs.writeFileSync(
      path.join(existingClient.defaultWorkspacePath, "shared.txt"),
      "authenticated value",
      "utf8",
    );
    const existingState = await executeCommand(
      origin,
      existingClient,
      existingLoginCookie,
      { id: "existing-state", type: "get_state" },
    );
    const existingSession = (
      existingState.payload as {
        data?: { sessionFile?: string; sessionId?: string };
      }
    ).data;
    const existingSessionPath = existingSession?.sessionFile;
    expect(existingSessionPath).toBeTruthy();
    fs.writeFileSync(
      existingSessionPath!,
      `${JSON.stringify({
        type: "session",
        id: existingSession?.sessionId,
        timestamp: "2026-08-11T00:00:00.000Z",
        cwd: existingClient.defaultWorkspacePath,
      })}\n`,
      "utf8",
    );

    const anonymous = await fetch(`${origin}/api/clients`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const guestClient = (await anonymous.json()) as TestBridgeClient;
    const guestCookie = cookieFrom(anonymous, "dano_guest");
    fs.writeFileSync(
      path.join(guestClient.defaultWorkspacePath, "shared.txt"),
      "guest value",
      "utf8",
    );
    const binaryValue = Buffer.from([0, 255, 254, 128, 65, 0]);
    fs.writeFileSync(
      path.join(guestClient.defaultWorkspacePath, "binary.bin"),
      binaryValue,
    );
    expect(
      (
        await fetch(
          `${origin}/api/clients/${guestClient.client.id}/preferences/theme`,
          {
            method: "PUT",
            headers: {
              Cookie: guestCookie,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ accentColorPreset: "purple" }),
          },
        )
      ).status,
    ).toBe(200);
    const guestState = await executeCommand(origin, guestClient, guestCookie, {
      id: "guest-state",
      type: "get_state",
    });
    const guestSession = (
      guestState.payload as {
        data?: { sessionFile?: string; sessionId?: string };
      }
    ).data;
    const guestSessionPath = guestSession?.sessionFile;
    expect(guestSessionPath).toBeTruthy();
    fs.writeFileSync(
      guestSessionPath!,
      `${JSON.stringify({
        type: "session",
        id: guestSession?.sessionId,
        timestamp: "2026-08-11T00:00:00.000Z",
        cwd: guestClient.defaultWorkspacePath,
      })}\n`,
      "utf8",
    );
    const guestUpload = await uploadProjectFile(
      origin,
      guestClient,
      guestCookie,
      "guest-upload.txt",
      "guest upload keeps its resource id",
    );

    const started = await fetch(`${origin}/api/auth/login`, {
      headers: { Cookie: guestCookie },
      redirect: "manual",
    });
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const callback = await fetch(
      `${origin}/api/auth/callback?code=merge-login&state=${state}`,
      { headers: { Cookie: guestCookie }, redirect: "manual" },
    );
    expect(cookieFrom(callback, "dano_login")).toMatch(/^dano_login=/);

    expect(
      fs.readFileSync(
        path.join(existingClient.defaultWorkspacePath, "shared.txt"),
        "utf8",
      ),
    ).toBe("authenticated value");
    expect(
      fs.readFileSync(
        path.join(
          existingClient.defaultWorkspacePath,
          "shared.anonymous-1.txt",
        ),
        "utf8",
      ),
    ).toBe("guest value");
    expect(
      fs.readFileSync(
        path.join(existingClient.defaultWorkspacePath, "binary.bin"),
      ),
    ).toEqual(binaryValue);
    const mergedPreference = await fetch(
      `${origin}/api/clients/${existingClient.client.id}/preferences/theme`,
      { headers: { Cookie: existingLoginCookie } },
    );
    expect(await mergedPreference.json()).toEqual({
      accentColorPreset: "blue",
    });
    expect(
      fs.readdirSync(
        path.join(
          path.dirname(path.dirname(existingClient.defaultWorkspacePath)),
          "preferences",
        ),
      ),
    ).toEqual(["theme.json"]);
    const sessions = await executeCommand(
      origin,
      existingClient,
      existingLoginCookie,
      {
        id: "merged-sessions",
        type: "list_sessions",
        workspacePath: existingClient.defaultWorkspacePath,
      },
    );
    const sessionPaths = (
      sessions.payload as { data?: { sessions?: Array<{ path: string }> } }
    ).data?.sessions?.map(session => session.path) ?? [];
    expect(sessionPaths).toHaveLength(2);
    expect(
      sessionPaths.map(sessionPath =>
        (JSON.parse(fs.readFileSync(sessionPath, "utf8")) as { id: string }).id,
      ),
    ).toEqual(
      expect.arrayContaining([
        existingSession?.sessionId,
        guestSession?.sessionId,
      ]),
    );
    expect(
      sessionPaths.every(sessionPath =>
        fs
          .readFileSync(sessionPath, "utf8")
          .includes(existingClient.defaultWorkspacePath),
      ),
    ).toBe(true);
    const uploadRecords = fs
      .readdirSync(path.join(runtimeRootPath, "uploads", "records"))
      .map(name =>
        JSON.parse(
          fs.readFileSync(
            path.join(runtimeRootPath, "uploads", "records", name),
            "utf8",
          ),
        ) as {
          upload: { id: string; ownerUserId: string; path: string };
        },
      );
    const transferredUpload = uploadRecords.find(
      record => record.upload.id === guestUpload.id,
    )?.upload;
    expect(transferredUpload).toMatchObject({
      id: guestUpload.id,
      ownerUserId: expect.stringMatching(/^oauth_/),
    });
    expect(transferredUpload?.path.startsWith(existingClient.defaultWorkspacePath)).toBe(
      true,
    );
    expect(fs.readFileSync(transferredUpload!.path, "utf8")).toBe(
      "guest upload keeps its resource id",
    );
  });

  it("rejects cross-origin and scheme-relative return paths", async () => {
    const provider: OAuthProviderAdapter = {
      authorizationUrl() {
        throw new Error("invalid return path must not reach provider");
      },
      async exchangeAuthorizationCode() {
        throw new Error("not used");
      },
    };
    const { origin } = await startOAuthServer(provider);

    for (const returnTo of ["https://outside.example.test/path", "//outside.test"]) {
      const response = await fetch(
        `${origin}/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
        { redirect: "manual" },
      );
      expect(response.status).toBe(400);
    }
  });

  it("consumes provider denial without creating a Login Session", async () => {
    let exchanges = 0;
    const provider: OAuthProviderAdapter = {
      authorizationUrl(input) {
        const url = new URL("https://provider.example.test/authorize");
        url.searchParams.set("state", input.state);
        return url;
      },
      async exchangeAuthorizationCode() {
        exchanges += 1;
        throw new Error("denial must not exchange a code");
      },
    };
    const { origin } = await startOAuthServer(provider);
    const started = await fetch(`${origin}/api/auth/login?returnTo=/denied`, {
      redirect: "manual",
    });
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;

    const denied = await fetch(
      `${origin}/api/auth/callback?error=access_denied&state=${state}`,
      {
        headers: { Cookie: cookieFrom(started, "dano_oauth_flow") },
        redirect: "manual",
      },
    );

    expect(denied.status).toBe(303);
    expect(denied.headers.get("location")).toBe("/denied");
    expect(denied.headers.get("set-cookie")).toBeNull();
    expect(exchanges).toBe(0);
  });

  it.each([
    {
      name: "invalid code",
      fakeProvider: {
        tokenStatus: 400,
        tokenResponse: { error: "invalid_grant" },
      },
    },
    {
      name: "missing identity",
      fakeProvider: { identity: { displayName: "Missing Identifier" } },
    },
  ])("leaves no partial state after $name", async ({ fakeProvider: setup }) => {
    const fakeProvider = await startFakeProvider(setup);
    const provider = createOAuth2ProviderAdapter({
      issuer: fakeProvider.origin,
      authorizationEndpoint: `${fakeProvider.origin}/authorize`,
      tokenEndpoint: `${fakeProvider.origin}/token`,
      identityEndpoint: `${fakeProvider.origin}/identity`,
      clientId: "failure-client",
      clientSecret: "failure-secret",
      scope: "profile",
      allowInsecureRequests: true,
    });
    const { origin, runtimeRootPath } = await startOAuthServer(provider);
    const started = await fetch(`${origin}/api/auth/login?returnTo=/failure`, {
      redirect: "manual",
    });
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;

    const callback = await fetch(
      `${origin}/api/auth/callback?code=fixture&state=${state}`,
      {
        headers: { Cookie: cookieFrom(started, "dano_oauth_flow") },
        redirect: "manual",
      },
    );

    expect(callback.headers.get("set-cookie")).toBeNull();
    expect(
      fs.readdirSync(path.join(runtimeRootPath, "auth", "login-sessions")),
    ).toEqual([]);
  });

  it("leaves no partial state when credential encryption fails", async () => {
    const credentialEncryptionKey = {
      version: "test-v1",
      key: Buffer.alloc(32, 3) as Uint8Array,
    };
    const provider: OAuthProviderAdapter = {
      authorizationUrl(input) {
        const url = new URL("https://provider.example.test/authorize");
        url.searchParams.set("state", input.state);
        return url;
      },
      async exchangeAuthorizationCode() {
        return {
          identity: { userId: "encryption-user" },
          credential: { accessToken: "encryption-token" },
        };
      },
    };
    const { origin, runtimeRootPath } = await startOAuthServer(
      provider,
      undefined,
      { credentialEncryptionKey },
    );
    const started = await fetch(`${origin}/api/auth/login`, {
      redirect: "manual",
    });
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;
    credentialEncryptionKey.key = Buffer.alloc(31, 3);

    const callback = await fetch(
      `${origin}/api/auth/callback?code=fixture&state=${state}`,
      {
        headers: { Cookie: cookieFrom(started, "dano_oauth_flow") },
        redirect: "manual",
      },
    );

    expect(callback.headers.get("set-cookie")).toBeNull();
    expect(
      fs.readdirSync(path.join(runtimeRootPath, "auth", "login-sessions")),
    ).toEqual([]);
  });

  it("times out the fake provider without leaving a partial Login Session", async () => {
    const fakeProvider = await startFakeProvider({ tokenDelayMs: 100 });
    const provider = createOAuth2ProviderAdapter({
      issuer: fakeProvider.origin,
      authorizationEndpoint: `${fakeProvider.origin}/authorize`,
      tokenEndpoint: `${fakeProvider.origin}/token`,
      identityEndpoint: `${fakeProvider.origin}/identity`,
      clientId: "fake-client",
      clientSecret: "fake-client-secret",
      scope: "profile",
      timeoutMs: 10,
      allowInsecureRequests: true,
    });
    const { origin, runtimeRootPath } = await startOAuthServer(provider);
    const started = await fetch(`${origin}/api/auth/login`, {
      redirect: "manual",
    });
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;

    const callback = await fetch(
      `${origin}/api/auth/callback?code=slow&state=${state}`,
      {
        headers: { Cookie: cookieFrom(started, "dano_oauth_flow") },
        redirect: "manual",
      },
    );

    expect(callback.headers.get("set-cookie")).toBeNull();
    expect(
      fs.readdirSync(path.join(runtimeRootPath, "auth", "login-sessions")),
    ).toEqual([]);
  });

  it("does not create a partial Login Session when persistent storage fails", async () => {
    const provider: OAuthProviderAdapter = {
      authorizationUrl(input) {
        const url = new URL("https://provider.example.test/authorize");
        url.searchParams.set("state", input.state);
        return url;
      },
      async exchangeAuthorizationCode() {
        return {
          identity: { userId: "storage-user" },
          credential: { accessToken: "storage-token" },
        };
      },
    };
    const { origin, runtimeRootPath } = await startOAuthServer(provider);
    const started = await fetch(`${origin}/api/auth/login`, {
      redirect: "manual",
    });
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const sessionsPath = path.join(
      runtimeRootPath,
      "auth",
      "login-sessions",
    );
    fs.rmdirSync(sessionsPath);
    fs.writeFileSync(sessionsPath, "storage unavailable", { mode: 0o600 });

    const callback = await fetch(
      `${origin}/api/auth/callback?code=fixture&state=${state}`,
      {
        headers: { Cookie: cookieFrom(started, "dano_oauth_flow") },
        redirect: "manual",
      },
    );

    expect(callback.headers.get("set-cookie")).toBeNull();
    expect(fs.statSync(sessionsPath).isFile()).toBe(true);
  });

  it("expires Login Sessions after eight idle hours", async () => {
    let currentTime = 1_000;
    const provider = successfulProvider("idle-user", "idle-token");
    const { origin } = await startOAuthServer(provider, undefined, {
      now: () => currentTime,
    });
    const loginCookie = await completeLogin(origin);

    currentTime += sessionHours(8) - 1;
    expect(
      await (
        await fetch(`${origin}/api/auth/current`, {
          headers: { Cookie: loginCookie },
        })
      ).json(),
    ).toMatchObject({ status: "authenticated" });
    currentTime += sessionHours(8);
    expect(
      await (
        await fetch(`${origin}/api/auth/current`, {
          headers: { Cookie: loginCookie },
        })
      ).json(),
    ).toEqual({ status: "anonymous" });
  });

  it("never extends a Login Session beyond seven absolute days", async () => {
    let currentTime = 1_000;
    const provider = successfulProvider("absolute-user", "absolute-token");
    const { origin } = await startOAuthServer(provider, undefined, {
      now: () => currentTime,
    });
    const loginCookie = await completeLogin(origin);
    for (
      currentTime = 1_000 + sessionHours(7);
      currentTime < 1_000 + sessionDays(7);
      currentTime += sessionHours(7)
    ) {
      const current = await fetch(`${origin}/api/auth/current`, {
        headers: { Cookie: loginCookie },
      });
      expect(await current.json()).toMatchObject({ status: "authenticated" });
    }
    currentTime = 1_000 + sessionDays(7);

    const expired = await fetch(`${origin}/api/auth/current`, {
      headers: { Cookie: loginCookie },
    });

    expect(await expired.json()).toEqual({ status: "anonymous" });
  });

  it("removes expired Login Sessions during startup and periodic GC", async () => {
    let currentTime = 1_000;
    const provider = successfulProvider("gc-user", "gc-token");
    const first = await startOAuthServer(provider, undefined, {
      now: () => currentTime,
    });
    const loginCookie = await completeLogin(first.origin);
    await first.controller.stop();
    await first.authentication.dispose();
    currentTime += sessionHours(8);
    const restarted = await startOAuthServer(
      provider,
      first.runtimeRootPath,
      { now: () => currentTime, sessionGcIntervalMs: 10 },
    );
    expect(
      await (
        await fetch(`${restarted.origin}/api/auth/current`, {
          headers: { Cookie: loginCookie },
        })
      ).json(),
    ).toEqual({ status: "anonymous" });

    const freshCookie = await completeLogin(restarted.origin);
    currentTime += sessionHours(8);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(
      await (
        await fetch(`${restarted.origin}/api/auth/current`, {
          headers: { Cookie: freshCookie },
        })
      ).json(),
    ).toEqual({ status: "anonymous" });
  });

  it("accepts missing display profile and creates an independent Session for every login", async () => {
    const provider = successfulProvider("profile-optional-user", "profile-token");
    const { origin, runtimeRootPath } = await startOAuthServer(provider);

    const firstCookie = await completeLogin(origin);
    const secondCookie = await completeLogin(origin);

    expect(firstCookie).not.toBe(secondCookie);
    const firstCurrent = await fetch(`${origin}/api/auth/current`, {
      headers: { Cookie: firstCookie },
    });
    expect(await firstCurrent.json()).toEqual({
      status: "authenticated",
      user: { username: "已登录用户" },
    });
    expect(
      fs.readdirSync(path.join(runtimeRootPath, "auth", "login-sessions")),
    ).toHaveLength(2);
  });

  it("lets only server modules read the Credential owned by one Login Session", async () => {
    const provider = successfulProvider("broker-user", "broker-access-token");
    const { authentication, origin } = await startOAuthServer(provider);
    const loginCookie = await completeLogin(origin);
    const loginSessionId = loginCookie.slice("dano_login=".length);

    await expect(
      authentication.readProviderCredential(loginSessionId),
    ).resolves.toEqual({ accessToken: "broker-access-token" });

    await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: loginCookie,
        Origin: "https://dano.example.test",
      },
    });
    await expect(
      authentication.readProviderCredential(loginSessionId),
    ).resolves.toBeNull();
  });

  it("atomically rotates one Login Session Credential through a single refresh flight", async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>(resolve => {
      releaseRefresh = resolve;
    });
    let refreshCount = 0;
    const provider: OAuthProviderAdapter = {
      ...successfulProvider("refresh-owner", "expired-access-token"),
      async exchangeAuthorizationCode() {
        return {
          identity: { userId: "refresh-owner" },
          credential: {
            accessToken: "expired-access-token",
            refreshToken: "retained-refresh-token",
          },
        };
      },
      async refreshCredential() {
        refreshCount += 1;
        await refreshGate;
        return { accessToken: "renewed-access-token" };
      },
    };
    const { authentication, origin } = await startOAuthServer(provider);
    const loginCookie = await completeLogin(origin);
    const loginSessionId = loginCookie.slice("dano_login=".length);

    const first = authentication.refreshProviderCredential(loginSessionId);
    const second = authentication.refreshProviderCredential(loginSessionId);
    await vi.waitFor(() => expect(refreshCount).toBe(1));
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        accessToken: "renewed-access-token",
        refreshToken: "retained-refresh-token",
      },
      {
        accessToken: "renewed-access-token",
        refreshToken: "retained-refresh-token",
      },
    ]);
    await expect(
      authentication.readProviderCredential(loginSessionId),
    ).resolves.toEqual({
      accessToken: "renewed-access-token",
      refreshToken: "retained-refresh-token",
    });
  });

  it("projects reauthentication, disconnects only its old Bridge Clients, and survives refresh", async () => {
    const provider: OAuthProviderAdapter = {
      ...successfulProvider("shared-reauth-user", "unused"),
      async exchangeAuthorizationCode({ code }) {
        return {
          identity: {
            userId: "shared-reauth-user",
            displayName: "Shared User",
          },
          credential: {
            accessToken: `access-${code}`,
            refreshToken: `refresh-${code}`,
          },
        };
      },
    };
    const { authentication, controller, origin } = await startOAuthServer(provider);
    const firstCookie = await completeLogin(origin, "first-login");
    const secondCookie = await completeLogin(origin, "second-login");
    const firstLoginSessionId = firstCookie.slice("dano_login=".length);
    const secondLoginSessionId = secondCookie.slice("dano_login=".length);
    const firstClient = await createAuthenticatedClient(origin, firstCookie);
    const secondClient = await createAuthenticatedClient(origin, secondCookie);
    const projected = waitForAuthentication(
      `${origin}${firstClient.eventsUrl}`,
      firstCookie,
    );
    await projected.ready;

    await authentication.requireReauthentication(firstLoginSessionId);
    controller.requireReauthentication(firstLoginSessionId);

    await expect(projected.result).resolves.toEqual({
      type: "authentication",
      payload: { status: "reauth_required" },
    });
    projected.close();
    await expect(
      fetch(`${origin}${firstClient.messagesUrl}`, {
        method: "POST",
        headers: { Cookie: firstCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "command",
          payload: { id: "stale-client", type: "get_state" },
        }),
      }),
    ).resolves.toMatchObject({ status: 404 });
    expect(controller.getClients()).toContainEqual(secondClient.client);
    await expect(
      (await fetch(`${origin}/api/auth/current`, {
        headers: { Cookie: firstCookie },
      })).json(),
    ).resolves.toEqual({ status: "reauth_required" });
    await expect(
      (await fetch(`${origin}/api/auth/current`, {
        headers: { Cookie: secondCookie },
      })).json(),
    ).resolves.toMatchObject({ status: "authenticated" });
    await expect(
      authentication.readProviderCredential(firstLoginSessionId),
    ).resolves.toBeNull();
    await expect(
      authentication.readProviderCredential(secondLoginSessionId),
    ).resolves.toMatchObject({ accessToken: "access-second-login" });

    const staleReload = await fetch(`${origin}/api/clients`, {
      method: "POST",
      headers: { Cookie: firstCookie, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(staleReload.status).toBe(401);
  });

  it("replaces a reauthentication record without affecting another Login Session", async () => {
    const provider: OAuthProviderAdapter = {
      ...successfulProvider("shared-relogin-user", "unused"),
      async exchangeAuthorizationCode({ code }) {
        return {
          identity: { userId: "shared-relogin-user" },
          credential: {
            accessToken: `access-${code}`,
            refreshToken: `refresh-${code}`,
          },
        };
      },
    };
    const { authentication, controller, origin, runtimeRootPath } =
      await startOAuthServer(provider);
    const staleCookie = await completeLogin(origin, "stale");
    const otherCookie = await completeLogin(origin, "other");
    const staleSessionId = staleCookie.slice("dano_login=".length);
    const otherSessionId = otherCookie.slice("dano_login=".length);
    await authentication.requireReauthentication(staleSessionId);
    controller.requireReauthentication(staleSessionId);

    const started = await fetch(`${origin}/api/auth/login?returnTo=/chat`, {
      headers: { Cookie: staleCookie },
      redirect: "manual",
    });
    const flowCookie = cookieFrom(started, "dano_oauth_flow");
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const callback = await fetch(
      `${origin}/api/auth/callback?code=relogin&state=${encodeURIComponent(state)}`,
      {
        headers: { Cookie: `${staleCookie}; ${flowCookie}` },
        redirect: "manual",
      },
    );
    const replacementCookie = cookieFrom(callback, "dano_login");
    const replacementSessionId = replacementCookie.slice("dano_login=".length);

    expect(replacementSessionId).not.toBe(staleSessionId);
    await expect(
      authentication.readProviderCredential(staleSessionId),
    ).resolves.toBeNull();
    await expect(
      authentication.readProviderCredential(replacementSessionId),
    ).resolves.toMatchObject({ accessToken: "access-relogin" });
    await expect(
      authentication.readProviderCredential(otherSessionId),
    ).resolves.toMatchObject({ accessToken: "access-other" });
    expect(
      fs.readdirSync(path.join(runtimeRootPath, "auth", "login-sessions")),
    ).toHaveLength(2);
  });

  it("cancels reauthentication into a fresh Anonymous User with a usable Bridge", async () => {
    const provider = successfulProvider("cancel-reauth-user", "expired-token");
    const { authentication, controller, origin } = await startOAuthServer(provider);
    const loginCookie = await completeLogin(origin);
    const loginSessionId = loginCookie.slice("dano_login=".length);
    const authenticatedClient = await createAuthenticatedClient(
      origin,
      loginCookie,
    );
    fs.writeFileSync(
      path.join(authenticatedClient.defaultWorkspacePath, "authenticated-only.txt"),
      "must remain with the authenticated User",
      "utf8",
    );
    await authentication.requireReauthentication(loginSessionId);
    controller.requireReauthentication(loginSessionId);

    const logout = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: loginCookie,
        Origin: "https://dano.example.test",
      },
    });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ status: "anonymous" });

    const created = await fetch(`${origin}/api/clients`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(created.status).toBe(201);
    const guestCookie = cookieFrom(created, "dano_guest");
    const guestClient = (await created.json()) as TestBridgeClient;
    expect(guestClient.defaultWorkspacePath).not.toBe(
      authenticatedClient.defaultWorkspacePath,
    );
    expect(
      fs.existsSync(
        path.join(guestClient.defaultWorkspacePath, "authenticated-only.txt"),
      ),
    ).toBe(false);
    expect(
      await executeCommand(origin, guestClient, guestCookie, {
        id: "anonymous-state",
        type: "get_state",
      }),
    ).toMatchObject({
      type: "response",
      payload: { id: "anonymous-state", success: true },
    });
  });

  it("logs out only the current Login Session and disconnects only its Bridge Clients", async () => {
    const revoked: string[] = [];
    const provider: OAuthProviderAdapter = {
      ...successfulProvider("shared-logout-user", "unused"),
      async exchangeAuthorizationCode({ code }) {
        return {
          identity: {
            userId: "shared-logout-user",
            displayName: "Shared User",
          },
          credential: { accessToken: `access-${code}` },
        };
      },
      async revokeCredential(credential) {
        revoked.push(credential.accessToken);
      },
    };
    const { origin, runtimeRootPath } = await startOAuthServer(provider);
    const firstCookie = await completeLogin(origin, "first-login");
    const secondCookie = await completeLogin(origin, "second-login");
    const firstClient = await createAuthenticatedClient(origin, firstCookie);
    const secondClient = await createAuthenticatedClient(origin, secondCookie);
    expect(firstClient.defaultWorkspacePath).toBe(
      secondClient.defaultWorkspacePath,
    );
    fs.writeFileSync(
      path.join(firstClient.defaultWorkspacePath, "authenticated-only.txt"),
      "do not copy on logout",
      "utf8",
    );
    expect(
      (
        await fetch(`${origin}/api/clients/${firstClient.client.id}/messages`, {
          method: "POST",
          headers: {
            Cookie: secondCookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "command",
            payload: { id: "wrong-login-session", type: "get_state" },
          }),
        })
      ).status,
    ).toBe(401);

    const logout = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: firstCookie,
        Origin: "https://dano.example.test",
      },
    });

    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toMatch(
      /^dano_login=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0$/,
    );
    expect(revoked).toEqual(["access-first-login"]);
    expect(
      await (
        await fetch(`${origin}/api/auth/current`, {
          headers: { Cookie: firstCookie },
        })
      ).json(),
    ).toEqual({ status: "anonymous" });
    expect(
      await (
        await fetch(`${origin}/api/auth/current`, {
          headers: { Cookie: secondCookie },
        })
      ).json(),
    ).toMatchObject({ status: "authenticated" });
    expect(
      (
        await fetch(
          `${origin}/api/clients/${firstClient.client.id}/messages`,
          {
            method: "POST",
            headers: {
              Cookie: firstCookie,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              type: "command",
              payload: { id: "old-client", type: "get_state" },
            }),
          },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(
          `${origin}/api/clients/${secondClient.client.id}/user`,
          { headers: { Cookie: secondCookie } },
        )
      ).status,
    ).toBe(200);
    expect(
      fs.readdirSync(path.join(runtimeRootPath, "auth", "login-sessions")),
    ).toHaveLength(1);
    const anonymous = await fetch(`${origin}/api/clients`, {
      method: "POST",
      headers: { Cookie: firstCookie, "Content-Type": "application/json" },
      body: "{}",
    });
    const anonymousClient = (await anonymous.json()) as TestBridgeClient & {
      authentication: { status: string };
    };
    const anonymousCookie = cookieFrom(anonymous, "dano_guest");
    expect(anonymousClient.authentication).toEqual({ status: "anonymous" });
    expect(anonymousClient.defaultWorkspacePath).not.toBe(
      firstClient.defaultWorkspacePath,
    );
    expect(
      fs.existsSync(
        path.join(anonymousClient.defaultWorkspacePath, "authenticated-only.txt"),
      ),
    ).toBe(false);
    const anonymousState = await executeCommand(
      origin,
      anonymousClient,
      anonymousCookie,
      { id: "anonymous-after-logout", type: "get_state" },
    );
    expect(anonymousState.payload).toMatchObject({
      command: "get_state",
      success: true,
    });
  });

  it("rejects cross-origin logout without revoking the Login Session", async () => {
    const revoked: string[] = [];
    const provider: OAuthProviderAdapter = {
      ...successfulProvider("csrf-user", "csrf-token"),
      async revokeCredential(credential) {
        revoked.push(credential.accessToken);
      },
    };
    const { origin } = await startOAuthServer(provider);
    const loginCookie = await completeLogin(origin);

    const rejected = await fetch(`${origin}/api/auth/logout`, {
      method: "POST",
      headers: {
        Cookie: loginCookie,
        Origin: "https://outside.example.test",
      },
    });

    expect(rejected.status).toBe(403);
    expect(revoked).toEqual([]);
    expect(
      await (
        await fetch(`${origin}/api/auth/current`, {
          headers: { Cookie: loginCookie },
        })
      ).json(),
    ).toMatchObject({ status: "authenticated" });
  });

  it("preserves the adapter-verified opaque userId exactly when deriving User ownership", async () => {
    let externalUserId = "opaque-user";
    const provider: OAuthProviderAdapter = {
      authorizationUrl(input) {
        const url = new URL("https://provider.example.test/authorize");
        url.searchParams.set("state", input.state);
        return url;
      },
      async exchangeAuthorizationCode() {
        return {
          identity: { userId: externalUserId },
          credential: { accessToken: "opaque-token" },
        };
      },
    };
    const { origin } = await startOAuthServer(provider);
    const firstCookie = await completeLogin(origin);
    externalUserId = " opaque-user ";
    const secondCookie = await completeLogin(origin);

    const firstClient = await fetch(`${origin}/api/clients`, {
      method: "POST",
      headers: { Cookie: firstCookie, "Content-Type": "application/json" },
      body: "{}",
    });
    const secondClient = await fetch(`${origin}/api/clients`, {
      method: "POST",
      headers: { Cookie: secondCookie, "Content-Type": "application/json" },
      body: "{}",
    });
    const firstBody = (await firstClient.json()) as {
      defaultWorkspacePath: string;
    };
    const secondBody = (await secondClient.json()) as {
      defaultWorkspacePath: string;
    };
    expect(firstBody.defaultWorkspacePath).not.toBe(
      secondBody.defaultWorkspacePath,
    );
  });
});

function successfulProvider(
  userId: string,
  accessToken: string,
): OAuthProviderAdapter {
  return {
    authorizationUrl(input) {
      const url = new URL("https://provider.example.test/authorize");
      url.searchParams.set("state", input.state);
      return url;
    },
    async exchangeAuthorizationCode() {
      return {
        identity: { userId },
        credential: { accessToken },
      };
    },
  };
}

async function completeLogin(
  origin: string,
  code = "fixture",
): Promise<string> {
  const started = await fetch(`${origin}/api/auth/login`, {
    redirect: "manual",
  });
  const state = new URL(started.headers.get("location")!).searchParams.get(
    "state",
  )!;
  const callback = await fetch(
    `${origin}/api/auth/callback?code=${encodeURIComponent(code)}&state=${state}`,
    {
      headers: { Cookie: cookieFrom(started, "dano_oauth_flow") },
      redirect: "manual",
    },
  );
  return cookieFrom(callback, "dano_login");
}

async function createAuthenticatedClient(origin: string, cookie: string) {
  const response = await fetch(`${origin}/api/clients`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(201);
  return (await response.json()) as TestBridgeClient;
}

type TestBridgeClient = {
  client: { id: string };
  defaultWorkspacePath: string;
  eventsUrl: string;
  messagesUrl: string;
};

function waitForResponse(
  url: string,
  cookie: string,
  correlationId: string,
): { close(): void; ready: Promise<void>; result: Promise<ServerMessage> } {
  let request: http.ClientRequest;
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => {
    markReady = resolve;
  });
  const result = new Promise<ServerMessage>((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error(`Timed out waiting for ${correlationId}`));
    }, 2_000);
    request = http.get(url, { headers: { Cookie: cookie } }, response => {
      markReady();
      response.setEncoding("utf8");
      response.on("data", chunk => {
        buffer += chunk;
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split(/\r?\n/)
            .filter(line => line.startsWith("data: "))
            .map(line => line.slice(6))
            .join("\n");
          if (data) {
            const message = JSON.parse(data) as ServerMessage;
            if (
              message.type === "response" &&
              message.payload.id === correlationId
            ) {
              clearTimeout(timeout);
              resolve(message);
              return;
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
  });
  return { ready, result, close: () => request.destroy() };
}

function waitForAuthentication(
  url: string,
  cookie: string,
): { close(): void; ready: Promise<void>; result: Promise<ServerMessage> } {
  let request: http.ClientRequest;
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => {
    markReady = resolve;
  });
  const result = new Promise<ServerMessage>((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error("Timed out waiting for authentication state"));
    }, 2_000);
    request = http.get(url, { headers: { Cookie: cookie } }, response => {
      markReady();
      response.setEncoding("utf8");
      response.on("data", chunk => {
        buffer += chunk;
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split(/\r?\n/)
            .filter(line => line.startsWith("data: "))
            .map(line => line.slice(6))
            .join("\n");
          if (data) {
            const message = JSON.parse(data) as ServerMessage;
            if (message.type === "authentication") {
              clearTimeout(timeout);
              resolve(message);
              return;
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
  });
  return { ready, result, close: () => request.destroy() };
}

async function executeCommand(
  origin: string,
  client: TestBridgeClient,
  cookie: string,
  payload: Extract<ClientMessage, { type: "command" }>["payload"],
): Promise<ServerMessage> {
  const correlationId = payload.id;
  if (!correlationId) throw new Error("Test commands require an id");
  const response = waitForResponse(
    `${origin}${client.eventsUrl}`,
    cookie,
    correlationId,
  );
  try {
    await response.ready;
    const posted = await fetch(`${origin}${client.messagesUrl}`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "command", payload } satisfies ClientMessage),
    });
    expect(posted.status).toBe(202);
    return await response.result;
  } finally {
    response.close();
  }
}

async function uploadProjectFile(
  origin: string,
  client: TestBridgeClient,
  cookie: string,
  name: string,
  content: string,
) {
  const body = new TextEncoder().encode(content);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const response = await fetch(
    `${origin}/api/uploads?clientId=${encodeURIComponent(client.client.id)}&name=${encodeURIComponent(name)}&mimeType=text/plain&sha256=${sha256}`,
    { method: "POST", headers: { Cookie: cookie }, body },
  );
  expect(response.status).toBe(201);
  return (await response.json()) as {
    id: string;
    path: string;
    previewUrl: string;
  };
}

function sessionHours(hours: number): number {
  return hours * 60 * 60 * 1000;
}

function sessionDays(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}
