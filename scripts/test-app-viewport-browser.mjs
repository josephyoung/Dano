import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import {
  availablePort,
  findChromeExecutable,
  startService,
  stopService,
  waitForHttp,
} from "./browser-test-harness.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const runtimeDir = mkdtempSync(join(tmpdir(), "dano-viewport-browser-"));
const agentConfigDir = join(runtimeDir, "empty-pi-agent");
mkdirSync(agentConfigDir, { recursive: true });

const serviceOutput = [];
const services = [];
let browser;
let fakeProviderServer;
const shortPrompt = "viewport short prompt";
const shortCompletion = "viewport test completion";
const longPrompt = "viewport long prompt";
const longCompletion = Array.from(
  { length: 900 },
  (_, index) => `viewport-overflow-${index}`,
).join(" ");
const geometryTolerance = 1;

function sanitizedEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/(?:_API_KEY|_ACCESS_KEY|_AUTH_TOKEN|_ACCESS_TOKEN|_SECRET_KEY)$/.test(key)) {
      delete env[key];
    }
  }
  delete env.PORT;
  return {
    ...env,
    DANO_RUNTIME_DIR: runtimeDir,
    PI_CODING_AGENT_DIR: agentConfigDir,
    ...overrides,
  };
}

async function startFakeProvider() {
  assert.deepEqual(
    readdirSync(agentConfigDir),
    [],
    "isolated PI_CODING_AGENT_DIR must start empty",
  );
  fakeProviderServer = createHttpServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const requestChunks = [];
    request.on("data", chunk => requestChunks.push(chunk));
    request.once("end", () => {
      const requestBody = Buffer.concat(requestChunks).toString("utf8");
      const completion = requestBody.includes(longPrompt) ? longCompletion : shortCompletion;
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const base = {
        id: "dano-viewport-browser-test",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "mimo-v2.5",
      };
      response.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: completion }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolveListen, reject) => {
    fakeProviderServer.once("error", reject);
    fakeProviderServer.listen(0, "127.0.0.1", resolveListen);
  });
  const address = fakeProviderServer.address();
  assert.ok(address && typeof address === "object");
  writeFileSync(
    join(agentConfigDir, "models.json"),
    `${JSON.stringify(
      {
        providers: {
          "xiaomi-token-plan-cn": {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "dano-local-browser-test-key",
            models: [
              {
                id: "mimo-v2.5",
                name: "Dano viewport browser test model",
                reasoning: false,
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

async function stopFakeProvider() {
  if (!fakeProviderServer) return;
  await new Promise(resolveClose => fakeProviderServer.close(resolveClose));
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}

async function waitForLayout(page) {
  await page.evaluate(() => new Promise(resolveFrame => {
    requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
  }));
}

async function sendPrompt(page, prompt, completion) {
  const textarea = page.locator("textarea.prompt-input");
  await textarea.fill(prompt);
  await textarea.press("Enter");
  await page.getByText(completion, { exact: true }).waitFor({ state: "visible" });
  await waitFor(() => textarea.isEnabled(), `${prompt} did not finish`);
  assert.equal(await page.getByText(prompt, { exact: true }).count(), 1);
  assert.equal(await page.getByText(completion, { exact: true }).count(), 1);
}

async function layoutMetrics(page) {
  return page.evaluate(tolerance => {
    const shell = document.querySelector(".app-shell");
    const transcript = document.querySelector(".chat-transcript");
    const composer = document.querySelector(".composer-bar");
    if (!(shell instanceof HTMLElement)) throw new Error("Missing App Shell");
    if (!(transcript instanceof HTMLElement)) throw new Error("Missing Chat Transcript");
    if (!(composer instanceof HTMLElement)) throw new Error("Missing Composer");
    const visualBottom =
      (window.visualViewport?.offsetTop ?? 0) +
      (window.visualViewport?.height ?? window.innerHeight);
    const visualTop = window.visualViewport?.offsetTop ?? 0;
    const composerRect = composer.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    return {
      composerBottom: composerRect.bottom,
      composerTop: composerRect.top,
      composerVisible:
        composerRect.top >= visualTop - tolerance &&
        composerRect.bottom <= visualBottom + tolerance,
      pageOverflow:
        document.documentElement.scrollHeight >
        document.documentElement.clientHeight + tolerance,
      shellBottom: shellRect.bottom,
      shellTop: shellRect.top,
      shellVisible:
        shellRect.top >= visualTop - tolerance &&
        shellRect.bottom <= visualBottom + tolerance,
      transcriptOverflow:
        transcript.scrollHeight > transcript.clientHeight + tolerance,
    };
  }, geometryTolerance);
}

function assertShortConversationLayout(metrics, label) {
  assert.equal(metrics.composerVisible, true, `${label}: Composer left the Visual Viewport`);
  assert.equal(metrics.pageOverflow, false, `${label}: document became the scroll owner`);
  assert.equal(metrics.shellVisible, true, `${label}: App Shell exceeded the Visual Viewport`);
  assert.equal(metrics.transcriptOverflow, false, `${label}: short Chat Transcript scrolled`);
}

function assertLongConversationLayout(metrics, label) {
  assert.equal(metrics.composerVisible, true, `${label}: Composer left the Visual Viewport`);
  assert.equal(metrics.pageOverflow, false, `${label}: document became the scroll owner`);
  assert.equal(metrics.shellVisible, true, `${label}: App Shell exceeded the Visual Viewport`);
  assert.equal(metrics.transcriptOverflow, true, `${label}: long Chat Transcript did not own scrolling`);
}

function assertLayoutRestored(before, after, label) {
  for (const field of ["composerTop", "composerBottom", "shellTop", "shellBottom"]) {
    assert.ok(
      Math.abs(after[field] - before[field]) <= geometryTolerance,
      `${label}: ${field} did not return to its keyboard-closed relationship ` +
        `(before=${before[field]}, after=${after[field]})`,
    );
  }
}

async function setViewport(page, viewport) {
  await page.setViewportSize(viewport);
  let previous;
  await waitFor(async () => {
    await waitForLayout(page);
    const current = await layoutMetrics(page);
    const stable = previous &&
      ["composerTop", "composerBottom", "shellTop", "shellBottom"].every(
        field => Math.abs(current[field] - previous[field]) <= geometryTolerance,
      );
    previous = current;
    return stable;
  }, "viewport layout did not settle");
}

async function run() {
  const executablePath = findChromeExecutable();
  assert.ok(executablePath, "No system Chrome/Chromium found");
  const backendPort = await availablePort();
  const frontendPort = await availablePort();
  const backendOrigin = `http://localhost:${backendPort}`;
  const frontendOrigin = `http://localhost:${frontendPort}`;

  await startFakeProvider();
  services.push(
    startService("pnpm", ["run", "dev:server"], {
      cwd: repoRoot,
      env: sanitizedEnvironment({
        DANO_HOST: "127.0.0.1",
        DANO_PORT: String(backendPort),
      }),
      output: serviceOutput,
    }),
  );
  await waitForHttp(`${backendOrigin}/api/health`, { services });
  services.push(
    startService(
      "pnpm",
      ["-C", "apps/dano", "exec", "vite", "--port", String(frontendPort), "--strictPort"],
      {
        cwd: repoRoot,
        env: sanitizedEnvironment({ DANO_DEV_BACKEND_ORIGIN: backendOrigin }),
        output: serviceOutput,
      },
    ),
  );
  await waitForHttp(frontendOrigin, { services });

  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage();
  await page.goto(frontendOrigin, { waitUntil: "domcontentloaded" });
  const textarea = page.locator("textarea.prompt-input");
  await textarea.waitFor({ state: "visible" });
  await waitFor(() => textarea.isEnabled(), "Dano did not connect to the isolated backend");

  const viewportPolicy = await page.locator('meta[name="viewport"]').getAttribute("content");
  assert.match(
    viewportPolicy ?? "",
    /(?:^|,)\s*interactive-widget\s*=\s*resizes-content(?:\s*,|$)/,
    "Dano must resize both layout and visual viewports for the soft keyboard",
  );

  await sendPrompt(page, shortPrompt, shortCompletion);

  const desktopViewports = [
    { label: "normal desktop", viewport: { width: 1280, height: 800 } },
    { label: "narrow desktop", viewport: { width: 1024, height: 800 } },
    { label: "low-height desktop", viewport: { width: 1280, height: 560 } },
  ];
  for (const { label, viewport } of desktopViewports) {
    await setViewport(page, viewport);
    assertShortConversationLayout(await layoutMetrics(page), label);
  }

  const mobileClosedViewport = { width: 390, height: 780 };
  const mobileContentViewport = { width: 390, height: 520 };
  await setViewport(page, mobileClosedViewport);
  const mobileClosedMetrics = await layoutMetrics(page);
  assertShortConversationLayout(mobileClosedMetrics, "mobile keyboard closed");

  await setViewport(page, mobileContentViewport);
  assertShortConversationLayout(await layoutMetrics(page), "mobile resizes-content");
  await setViewport(page, mobileClosedViewport);
  const mobileRestoredMetrics = await layoutMetrics(page);
  assertShortConversationLayout(mobileRestoredMetrics, "mobile keyboard restored");
  assertLayoutRestored(
    mobileClosedMetrics,
    mobileRestoredMetrics,
    "mobile keyboard restored",
  );

  await sendPrompt(page, longPrompt, longCompletion);
  assertLongConversationLayout(await layoutMetrics(page), "mobile long conversation");

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    ...mobileClosedViewport,
    deviceScaleFactor: 1,
    mobile: true,
    dontSetVisibleSize: true,
  });
  await cdp.send("Emulation.setPageScaleFactor", {
    pageScaleFactor: mobileClosedViewport.height / mobileContentViewport.height,
  });
  await waitForLayout(page);
  const resizesVisualControl = await layoutMetrics(page);
  assert.equal(
    resizesVisualControl.composerVisible,
    false,
    "resizes-visual control did not expose the original hidden Composer",
  );
  assert.equal(
    resizesVisualControl.shellVisible,
    false,
    "resizes-visual control did not expose the App Shell mismatch",
  );
}

try {
  await run();
  console.log("[app-viewport-browser] PASS");
} catch (error) {
  console.error(error?.stack ?? error);
  if (serviceOutput.length > 0) console.error(serviceOutput.join(""));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await Promise.allSettled(services.reverse().map(stopService));
  await stopFakeProvider().catch(() => {});
  rmSync(runtimeDir, { recursive: true, force: true });
}
