import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { expect, it, vi } from "vitest";
import { createAnonymousUserContextResolver } from "../anonymous-user-context.js";
import { BridgeEventBus } from "../bridge-event-bus.js";
import { createOAuthAuthentication } from "../oauth-authentication.js";
import { BridgeServer } from "../server.js";
import { DEFAULT_BRIDGE_CONFIG } from "../types.js";
import { UserRuntimeRegistry } from "../user-runtime-registry.js";

it.each(["anonymous", "authenticated"] as const)(
  "completes OAuth login while an %s User command remains in flight",
  async busyUser => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dano-login-priority-"));
    const authentication = await createOAuthAuthentication({
      runtimeRootPath: root,
      appOrigin: "https://dano.example.test",
      redirectUri: "https://dano.example.test/api/auth/callback",
      credentialEncryptionKey: { version: "fixture", key: Buffer.alloc(32, 7) },
      provider: {
        authorizationUrl: ({ state }) => new URL(`https://oa.example.test/login?state=${state}`),
        async exchangeAuthorizationCode() {
          return { identity: { userId: "busy-owner" }, credential: { accessToken: "fixture" } };
        },
      },
    });
    const resolver = createAnonymousUserContextResolver({
      runtimeRootPath: root, secureCookie: false, authenticatedResolver: authentication,
    });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = vi.fn();
    const finished = vi.fn();
    const disposed = vi.fn();
    const registry = new UserRuntimeRegistry(async () => { throw new Error("UNUSED_BACKEND"); });
    const eventBus = new BridgeEventBus(DEFAULT_BRIDGE_CONFIG);
    const server = new BridgeServer(
      { ...DEFAULT_BRIDGE_CONFIG, host: "127.0.0.1", port: 0, userTransferTimeoutMs: 50,
        upload: { ...DEFAULT_BRIDGE_CONFIG.upload, uploadDir: path.join(root, "uploads") } },
      context => ({
        defaultWorkspacePath: path.join(context.user!.folderPath, "workspaces", "default"),
        async handleClientMessage() { entered(); await gate; finished(); },
        dispose: disposed,
      }),
      eventBus, vi.fn(), resolver, authentication, registry,
    );
    let sse: http.ClientRequest | undefined;
    try {
      const { port } = await server.start();
      const origin = `http://127.0.0.1:${port}`;
      const cookie = (response: Response) => response.headers.get("set-cookie")!.split(";", 1)[0]!;
      const login = async (guestCookie?: string) => {
        const start = await fetch(`${origin}/api/auth/login`, {
          headers: guestCookie ? { Cookie: guestCookie } : {}, redirect: "manual",
        });
        const state = new URL(start.headers.get("location")!).searchParams.get("state");
        return fetch(`${origin}/api/auth/callback?code=fixture&state=${state}`, {
          headers: { Cookie: guestCookie ?? cookie(start) }, redirect: "manual",
          signal: AbortSignal.timeout(2_000),
        });
      };
      const guestResponse = await fetch(`${origin}/api/clients`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const guestCookie = cookie(guestResponse);
      const guest = await guestResponse.json() as { client: { id: string }; eventsUrl: string; messagesUrl: string };
      let busyClient = guest;
      let busyCookie = guestCookie;
      if (busyUser === "authenticated") {
        busyCookie = cookie(await login());
        const response = await fetch(`${origin}/api/clients`, {
          method: "POST", headers: { Cookie: busyCookie, "Content-Type": "application/json" }, body: "{}",
        });
        busyClient = await response.json() as typeof guest;
      }
      sse = http.get(`${origin}${busyClient.eventsUrl}`, { headers: { Cookie: busyCookie } }, res => res.resume());
      await vi.waitFor(() => expect(eventBus.hasActiveClientConnection(busyClient.client.id)).toBe(true));
      const command = await fetch(`${origin}${busyClient.messagesUrl}`, {
        method: "POST", headers: { Cookie: busyCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "command", payload: { id: "held-command", type: "get_state" } }),
      });
      expect(command.status).toBe(202);
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
      const callback = await login(guestCookie);
      expect(callback.status).toBe(303);
      expect(cookie(callback)).toMatch(/^dano_login=/);
      expect(callback.headers.get("location")).toBe("/?dano_new_chat=1");
      expect(finished).not.toHaveBeenCalled();
      expect(disposed).not.toHaveBeenCalled();
      const current = await fetch(`${origin}/api/auth/current`, { headers: { Cookie: cookie(callback) } });
      expect(await current.json()).toMatchObject({ status: "authenticated" });
      release();
      await vi.waitFor(() => expect(finished).toHaveBeenCalledOnce());
    } finally {
      release();
      sse?.destroy();
      await server.stop();
      await registry.dispose();
      await authentication.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
