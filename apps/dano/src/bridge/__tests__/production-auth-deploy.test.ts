import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = new URL("../../../../../", import.meta.url);
const readRoot = (path: string): string =>
  readFileSync(new URL(path, root), "utf8");
const nginx = findExecutable("nginx");
const runNginxRuntimeTest = process.env.DANO_NGINX_RUNTIME_TEST === "1";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("production authentication deployment contract", () => {
  it("configures only OAuth, Login Session, and Anonymous User authentication", () => {
    const compose = readRoot("docker-compose.yml");
    const required = [
      "DANO_OAUTH_ISSUER",
      "DANO_OAUTH_AUTHORIZATION_ENDPOINT",
      "DANO_OAUTH_TOKEN_ENDPOINT",
      "DANO_OAUTH_IDENTITY_ENDPOINT",
      "DANO_OAUTH_API_ORIGIN",
      "DANO_OAUTH_CLIENT_ID",
      "DANO_OAUTH_CLIENT_SECRET",
      "DANO_OAUTH_SCOPE",
      "DANO_OAUTH_REDIRECT_URI",
      "DANO_OAUTH_CREDENTIAL_KEY",
      "DANO_OAUTH_CREDENTIAL_KEY_VERSION",
      "DANO_LOGIN_SESSION_IDLE_TTL_MS",
      "DANO_LOGIN_SESSION_ABSOLUTE_TTL_MS",
      "DANO_LOGIN_SESSION_CLEANUP_INTERVAL_MS",
      "DANO_ANONYMOUS_IDLE_TTL_MS",
      "DANO_ANONYMOUS_CLEANUP_INTERVAL_MS",
    ];

    for (const name of required) expect(compose).toContain(`${name}:`);
    expect(compose).not.toMatch(/DANO_(?:DEMO|AUTH_JWT|AUTH_COOKIE)/);
    expect(compose).not.toContain("demo-auth.conf.template");
  });

  it("removes the fixed Demo Cookie and identity initialization from releases", () => {
    const packageJson = readRoot("package.json");
    const release = readRoot("scripts/deploy-release.mjs");
    const proxy = readRoot("deploy/nginx/shared/proxy-server.conf");

    expect(packageJson).not.toContain("deploy:init-demo-auth");
    expect(
      existsSync(new URL("scripts/init-demo-auth.mjs", root)),
    ).toBe(false);
    expect(
      existsSync(new URL("deploy/nginx/demo-auth.conf.template", root)),
    ).toBe(false);
    expect(release).not.toMatch(/init-demo-auth|demo-auth\.conf/);
    expect(release).toContain('"DANO_DEMO_JWT"');
    expect(release).toContain("removeEnvFileValues");
    expect(release).toContain('"--entrypoint"');
    expect(release).toContain('"--validate-config"');
    expect(proxy).not.toContain("dano_demo");
    expect(proxy).not.toContain("add_header Set-Cookie");
  });

  it("forwards auth Cookies and Origin without logging callback secrets", () => {
    const proxy = readRoot("deploy/nginx/shared/proxy-server.conf");

    expect(proxy).toContain("location = /api/auth/callback");
    expect(proxy).toContain("location ^~ /api/auth/");
    expect(proxy).toContain("proxy_set_header Cookie $http_cookie;");
    expect(proxy).toContain("proxy_set_header Origin $http_origin;");
    expect(proxy).toMatch(
      /location = \/api\/auth\/callback[\s\S]*access_log off;/,
    );
    expect(proxy).toMatch(
      /location = \/api\/auth\/callback[\s\S]*error_log \/dev\/null;/,
    );
    expect(proxy).toContain("proxy_pass http://dano_app;");
  });

  it.skipIf(!runNginxRuntimeTest)(
    "keeps callback credentials out of nginx logs when the upstream fails",
    async () => {
      expect(nginx, "auth release gate requires an nginx executable").toBeDefined();
      const temporaryRoot = mkdtempSync(join(tmpdir(), "dano-nginx-auth-"));
      temporaryRoots.push(temporaryRoot);
      const accessLog = join(temporaryRoot, "access.log");
      const errorLog = join(temporaryRoot, "error.log");
      const configPath = join(temporaryRoot, "nginx.conf");
      const port = await reservePort();
      const sentinel = "sentinel-code-must-not-enter-logs";
      writeFileSync(
        configPath,
        `worker_processes 1;
pid ${join(temporaryRoot, "nginx.pid")};
error_log ${errorLog} notice;
events { worker_connections 32; }
http {
  access_log ${accessLog} combined;
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }
  upstream dano_app { server 127.0.0.1:1; }
  server {
    listen 127.0.0.1:${port};
    include ${new URL("../../../../../deploy/nginx/shared/proxy-server.conf", import.meta.url).pathname};
  }
}
`,
      );

      const child = spawn(nginx!, ["-p", temporaryRoot, "-c", configPath, "-g", "daemon off;"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => (stderr += chunk));

      try {
        await waitForNginx(port, child);
        const response = await fetch(
          `http://127.0.0.1:${port}/api/auth/callback?code=${sentinel}&state=${sentinel}`,
        );
        expect(response.status).toBe(502);
      } finally {
        if (child.exitCode === null) child.kill("SIGTERM");
        await new Promise<void>(resolveExit => {
          if (child.exitCode !== null) resolveExit();
          else child.once("exit", () => resolveExit());
        });
      }

      const logs = [accessLog, errorLog]
        .filter(existsSync)
        .map(path => readFileSync(path, "utf8"))
        .concat(stderr)
        .join("\n");
      expect(logs).not.toContain(sentinel);
    },
  );

  it("smokes an isolated Anonymous User instead of a fixed identity", () => {
    const smoke = readRoot("scripts/smoke-dano-deploy.mjs");

    expect(smoke).toContain("dano_guest");
    expect(smoke).toContain('status === "anonymous"');
    expect(smoke).not.toMatch(/Demo|DANO_AUTH_JWT|DANO_DEMO|createHmac/);
  });

  it("publishes one fake-provider release acceptance command", () => {
    const packageJson = JSON.parse(readRoot("package.json")) as {
      scripts?: Record<string, string>;
    };
    const gate = packageJson.scripts?.["test:auth-release"] ?? "";

    expect(gate).toContain("oauth-login-http.test.ts");
    expect(gate).toContain("anonymous-user-http.test.ts");
    expect(gate).toContain("user-runtime-isolation-http.test.ts");
    expect(gate).toContain("credential-broker.test.ts");
    expect(gate).toContain("anonymous-user-cleanup.test.ts");
    expect(gate).toContain("AppHeader.test.ts");
    expect(gate).toContain("ReauthenticationDialog.test.ts");
    expect(gate).toContain("bridgeStore.prompt.test.ts");
    expect(gate).toContain("main.test.ts");
    expect(gate).toContain("deploy-compose.test.ts");
    expect(gate).toContain("test:auth-built-entrypoint");
    expect(gate).toContain("DANO_NGINX_RUNTIME_TEST=1");
    expect(gate).toContain("bridge-rpc-adapter.test.ts");
    expect(gate).toContain(
      "projects provider_request results as JSON-safe transcript data",
    );
    expect(gate).toContain("production-auth-deploy.test.ts");
  });
});

function findExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching the configured PATH.
    }
  }
  return undefined;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to reserve an nginx test port");
  }
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  return address.port;
}

async function waitForNginx(
  port: number,
  child: ReturnType<typeof spawn>,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `nginx exited before accepting requests (${child.exitCode ?? child.signalCode})`,
      );
    }
    try {
      await fetch(`http://127.0.0.1:${port}/api/auth/current`);
      return;
    } catch {
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
  }
  throw new Error("nginx did not accept requests");
}
