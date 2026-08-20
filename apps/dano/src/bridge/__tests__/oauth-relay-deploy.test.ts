import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = new URL("../../../../../", import.meta.url);
const proxyConfig = new URL(
  "../../../../../deploy/nginx/shared/proxy-server.conf",
  import.meta.url,
).pathname;
const checker = new URL(
  "../../../../../scripts/check-oauth-relay-contract.mjs",
  import.meta.url,
).pathname;
const composeConfig = new URL(
  "../../../../../docker-compose.yml",
  import.meta.url,
).pathname;
const nginx = findExecutable("nginx");
const runNginxRuntimeTest = process.env.DANO_NGINX_RUNTIME_TEST === "1";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("OAuth relay deployment contract", () => {
  it("preserves the upstream prefix without a hardcoded dead origin", () => {
    const compose = readFileSync(composeConfig, "utf8");
    const proxy = readFileSync(proxyConfig, "utf8");

    expect(compose).toContain(
      "DANO_OAUTH_RELAY_ORIGIN: ${DANO_OAUTH_RELAY_ORIGIN:-}",
    );
    expect(compose).not.toContain("127.0.0.1:9");
    expect(proxy).not.toMatch(/\brewrite\s+\^\/admin-api/);
  });

  it("checks nginx-parsed relay config without printing config or secrets", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "dano-oauth-checker-"));
    temporaryRoots.push(temporaryRoot);
    const output = execFileSync(process.execPath, [checker], {
      cwd: root.pathname,
      encoding: "utf8",
      env: {
        ...process.env,
        DANO_COMPOSE: writeFakeCompose(temporaryRoot),
        DANO_FAKE_NGINX_CONFIG: renderedRelayConfig(),
        DANO_OAUTH_CLIENT_SECRET: "secret-sentinel",
      },
    });

    expect(output.trim()).toBe("[oauth-relay-contract] valid");
    expect(output).not.toContain("secret-sentinel");
  });

  it("does not accept relay directives hidden in comments", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "dano-oauth-checker-"));
    temporaryRoots.push(temporaryRoot);

    expect(() =>
      execFileSync(process.execPath, [checker], {
        cwd: root.pathname,
        stdio: "pipe",
        env: {
          ...process.env,
          DANO_COMPOSE: writeFakeCompose(temporaryRoot),
          DANO_FAKE_NGINX_CONFIG: renderedRelayConfig().replace(
            "sub_filter '(/logo' '(/admin-api/logo';",
            "# sub_filter '(/logo' '(/admin-api/logo';",
          ),
        },
      }),
    ).toThrow();
  });

  it("requires an explicit relay origin for /admin-api/ OAuth endpoints", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "dano-oauth-checker-"));
    temporaryRoots.push(temporaryRoot);
    const env = { ...process.env };
    delete env.DANO_OAUTH_RELAY_ORIGIN;

    expect(() =>
      execFileSync(process.execPath, [checker], {
        cwd: root.pathname,
        stdio: "pipe",
        env: {
          ...env,
          DANO_COMPOSE: writeFakeCompose(temporaryRoot),
          DANO_FAKE_NGINX_CONFIG: renderedRelayConfig(),
          DANO_OAUTH_TOKEN_ENDPOINT:
            "https://dano.invalid/admin-api/system/oauth2/token",
        },
      }),
    ).toThrow();
  });

  it.skipIf(!nginx || !runNginxRuntimeTest)(
    "preserves /admin-api and isolates authorization HTML and dynamic resources",
    async () => {
      const temporaryRoot = mkdtempSync(join(tmpdir(), "dano-oauth-relay-"));
      temporaryRoots.push(temporaryRoot);
      const relayPort = await reservePort();
      const upstreamPort = await reservePort();
      const requestedPaths: string[] = [];
      const upstream = createServer((request, response) => {
        requestedPaths.push(request.url ?? "");
        if (request.url === "/admin-api/oauth/authorize") {
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<script src="/assets/app.js"></script><img src="/logo.svg"><img src=/logo-unquoted.svg><link href="/favicon.ico">',
          );
          return;
        }
        if (request.url === "/admin-api/assets/app.js") {
          response.setHeader("Content-Type", "application/javascript");
          response.end(
            "const chunk=\"/assets/chunk.js\";const logo=`/logo-dynamic.svg`;const icon=`/favicon-dynamic.ico`;",
          );
          return;
        }
        if (request.url === "/admin-api/styles.css") {
          response.setHeader("Content-Type", "text/css");
          response.end(
            ".brand{background:url(/logo-css.svg)}.icon{background:url(/favicon-css.ico)}",
          );
          return;
        }
        response.end(`upstream:${request.url}`);
      });
      await new Promise<void>((resolve, reject) => {
        upstream.once("error", reject);
        upstream.listen(upstreamPort, "127.0.0.1", resolve);
      });

      const configPath = join(temporaryRoot, "nginx.conf");
      writeFileSync(
        configPath,
        `worker_processes 1;
pid ${join(temporaryRoot, "nginx.pid")};
error_log ${join(temporaryRoot, "error.log")} notice;
events { worker_connections 32; }
http {
  access_log off;
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }
  upstream dano_app { server 127.0.0.1:1; }
  server {
    listen 127.0.0.1:${relayPort};
    set $dano_oauth_relay_origin "http://127.0.0.1:${upstreamPort}";
    include ${proxyConfig};
  }
}
`,
      );
      const child = spawn(
        nginx!,
        [
          "-p",
          temporaryRoot,
          "-c",
          configPath,
          "-e",
          "stderr",
          "-g",
          "daemon off;",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => (stderr += chunk));

      try {
        await waitForNginx(relayPort, child, () => stderr);
        const html = await fetch(
          `http://127.0.0.1:${relayPort}/admin-api/oauth/authorize`,
        ).then(response => response.text());
        const script = await fetch(
          `http://127.0.0.1:${relayPort}/admin-api/assets/app.js`,
        ).then(response => response.text());
        const css = await fetch(
          `http://127.0.0.1:${relayPort}/admin-api/styles.css`,
        ).then(response => response.text());
        await fetch(`http://127.0.0.1:${relayPort}/admin-api/logo.svg`);
        await fetch(`http://127.0.0.1:${relayPort}/admin-api/favicon.ico`);

        expect(html).toContain('src="/admin-api/assets/app.js"');
        expect(html).toContain('src="/admin-api/logo.svg"');
        expect(html).toContain("src=/admin-api/logo-unquoted.svg");
        expect(html).toContain('href="/admin-api/favicon.ico"');
        expect(script).toContain('"/admin-api/assets/chunk.js"');
        expect(script).toContain("`/admin-api/logo-dynamic.svg`");
        expect(script).toContain("`/admin-api/favicon-dynamic.ico`");
        expect(css).toContain("url(/admin-api/logo-css.svg)");
        expect(css).toContain("url(/admin-api/favicon-css.ico)");
        expect(requestedPaths).toEqual([
          "/admin-api/oauth/authorize",
          "/admin-api/assets/app.js",
          "/admin-api/styles.css",
          "/admin-api/logo.svg",
          "/admin-api/favicon.ico",
        ]);
      } finally {
        if (child.exitCode === null) child.kill("SIGTERM");
        await new Promise<void>(resolve => {
          if (child.exitCode !== null) resolve();
          else child.once("exit", () => resolve());
        });
        await new Promise<void>(resolve => upstream.close(() => resolve()));
      }
      expect(stderr).not.toContain("emerg");
    },
  );
});

function writeFakeCompose(rootPath: string): string {
  const compose = join(rootPath, "compose");
  writeFileSync(
    compose,
    `#!/usr/bin/env node
if (!process.argv.includes("-T")) process.exit(2);
process.stdout.write(process.env.DANO_FAKE_NGINX_CONFIG ?? "");
`,
  );
  chmodSync(compose, 0o755);
  return compose;
}

function renderedRelayConfig(): string {
  return `server {
  set $dano_oauth_relay_origin "https://oauth-relay-contract.invalid";
  ${readFileSync(proxyConfig, "utf8")}
}
`;
}

function findExecutable(name: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

async function waitForNginx(
  port: number,
  child: ReturnType<typeof spawn>,
  stderr: () => string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const status = child.exitCode ?? child.signalCode;
      throw new Error(`nginx exited before startup (${status}): ${stderr()}`);
    }
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  throw new Error("nginx did not accept requests");
}
