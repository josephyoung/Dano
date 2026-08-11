import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAnonymousUserContextResolver } from "../bridge/anonymous-user-context.js";
import {
  createOAuthAuthentication,
  type OAuthAuthenticationOptions,
  type OAuthProviderAdapter,
} from "../bridge/oauth-authentication.js";
import { createOAuth2ProviderAdapter } from "../bridge/oauth-provider.js";
import { DEFAULT_BRIDGE_CONFIG } from "../bridge/types.js";
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
  const controller = await startDanoServer(
    { ...DEFAULT_BRIDGE_CONFIG, host: "127.0.0.1", port: 0 },
    {
      captureSigint: false,
      userContextResolver: createAnonymousUserContextResolver({
        runtimeRootPath,
        secureCookie: false,
        authenticatedResolver: authentication,
      }),
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
  tokenResponse?: unknown;
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
              options.tokenResponse ?? {
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
    const { origin } = await startOAuthServer(provider);

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

async function completeLogin(origin: string): Promise<string> {
  const started = await fetch(`${origin}/api/auth/login`, {
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
  return cookieFrom(callback, "dano_login");
}

function sessionHours(hours: number): number {
  return hours * 60 * 60 * 1000;
}

function sessionDays(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}
