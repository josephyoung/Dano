import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
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
const nginx = findExecutable("nginx");
const runNginxRuntimeTest = process.env.DANO_NGINX_RUNTIME_TEST === "1";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("OAuth relay deployment contract", () => {
  it("checks the domain-independent relay contract without printing config", () => {
    const output = execFileSync(process.execPath, [checker], {
      cwd: root.pathname,
      encoding: "utf8",
    });
    const proxy = readFileSync(proxyConfig, "utf8");
    const relayStart = proxy.indexOf("location ^~ /admin-api/");
    const relay = proxy.slice(relayStart, proxy.indexOf("\n}\n", relayStart));

    expect(output.trim()).toBe("[oauth-relay-contract] valid");
    expect(relay).not.toMatch(/proxy_pass\s+https?:\/\//);
  });

  it.skipIf(!nginx || !runNginxRuntimeTest)(
    "strips /admin-api and isolates authorization HTML and dynamic resources",
    async () => {
      const temporaryRoot = mkdtempSync(join(tmpdir(), "dano-oauth-relay-"));
      temporaryRoots.push(temporaryRoot);
      const relayPort = await reservePort();
      const upstreamPort = await reservePort();
      const requestedPaths: string[] = [];
      const upstream = createServer((request, response) => {
        requestedPaths.push(request.url ?? "");
        if (request.url === "/oauth/authorize") {
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<script src="/assets/app.js"></script><img src="/logo.svg"><link href="/favicon.ico">',
          );
          return;
        }
        if (request.url === "/assets/app.js") {
          response.setHeader("Content-Type", "application/javascript");
          response.end(
            'const chunk="/assets/chunk.js";const logo="/logo-dynamic.svg";const icon="/favicon-dynamic.ico";',
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
        await fetch(`http://127.0.0.1:${relayPort}/admin-api/logo.svg`);
        await fetch(`http://127.0.0.1:${relayPort}/admin-api/favicon.ico`);

        expect(html).toContain('src="/admin-api/assets/app.js"');
        expect(html).toContain('src="/admin-api/logo.svg"');
        expect(html).toContain('href="/admin-api/favicon.ico"');
        expect(script).toContain('"/admin-api/assets/chunk.js"');
        expect(script).toContain('"/admin-api/logo-dynamic.svg"');
        expect(script).toContain('"/admin-api/favicon-dynamic.ico"');
        expect(requestedPaths).toEqual([
          "/oauth/authorize",
          "/assets/app.js",
          "/logo.svg",
          "/favicon.ico",
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
