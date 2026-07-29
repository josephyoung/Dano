import assert from "node:assert/strict";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import {
  availablePort,
  findChromeExecutable,
  startService,
  stopService,
  waitForHttp,
} from "./browser-test-harness.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
let vite;
let browser;
const serviceOutput = [];

async function waitForLayout(page) {
  await page.evaluate(() => new Promise(resolveFrame =>
    requestAnimationFrame(() => requestAnimationFrame(resolveFrame))
  ));
}

async function textareaMetrics(page) {
  return page.locator(".prompt-input").evaluate(element => {
    const textarea = /** @type {HTMLTextAreaElement} */ (element);
    const style = getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(style.lineHeight);
    const padding = Number.parseFloat(style.paddingTop) +
      Number.parseFloat(style.paddingBottom);
    return {
      clientHeight: textarea.clientHeight,
      scrollHeight: textarea.scrollHeight,
      lineHeight,
      requiredLines: Math.round((textarea.scrollHeight - padding) / lineHeight),
      overflowY: style.overflowY,
      value: textarea.value,
    };
  });
}

function assertVisibleThroughFiveLines(metrics, label) {
  assert.ok(
    metrics.requiredLines <= 5,
    `${label}: test input unexpectedly needs ${metrics.requiredLines} lines`,
  );
  assert.ok(
    metrics.clientHeight >= metrics.scrollHeight,
    `${label}: expected all text to be visible; clientHeight=${metrics.clientHeight}, scrollHeight=${metrics.scrollHeight}, overflowY=${metrics.overflowY}`,
  );
}

async function replaceInput(page, text, inputType = "insertText") {
  await page.locator(".prompt-input").evaluate((element, input) => {
    const textarea = /** @type {HTMLTextAreaElement} */ (element);
    textarea.value = input.text;
    textarea.setSelectionRange(input.text.length, input.text.length);
    textarea.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      data: input.text,
      inputType: input.inputType,
    }));
  }, { text, inputType });
  await waitForLayout(page);
}

async function run() {
  const executablePath = findChromeExecutable();
  assert.ok(executablePath, "No system Chrome/Chromium found");
  const port = await availablePort();
  const origin = `http://localhost:${port}`;
  vite = startService(
    "pnpm",
    ["-C", "apps/dano", "exec", "vite", "--port", String(port), "--strictPort"],
    { cwd: repoRoot, output: serviceOutput },
  );
  await waitForHttp(`${origin}/composer-autosize-test.html`, { services: [vite] });

  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1_440, height: 900 } });
  await page.goto(`${origin}/composer-autosize-test.html`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByTestId("backfill-revision").evaluate(button => button.click());
  await waitForLayout(page);

  const observedLines = new Set();
  for (let width = 1_440; width >= 320; width -= 20) {
    await page.setViewportSize({ width, height: 900 });
    await waitForLayout(page);
    const metrics = await textareaMetrics(page);
    if (metrics.requiredLines <= 5) {
      observedLines.add(metrics.requiredLines);
      assert.ok(
        metrics.clientHeight >= metrics.scrollHeight,
        `${width}px / ${metrics.requiredLines} lines: expected all backfilled text to remain visible; clientHeight=${metrics.clientHeight}, scrollHeight=${metrics.scrollHeight}, overflowY=${metrics.overflowY}`,
      );
    } else {
      assert.ok(
        metrics.clientHeight < metrics.scrollHeight,
        `${width}px / ${metrics.requiredLines} lines: expected content beyond five lines to scroll internally`,
      );
      assert.ok(
        Math.abs(metrics.clientHeight - metrics.lineHeight * 5) <= 1,
        `${width}px / ${metrics.requiredLines} lines: expected the textarea to stop at exactly five visible lines; clientHeight=${metrics.clientHeight}, lineHeight=${metrics.lineHeight}`,
      );
      assert.equal(metrics.overflowY, "auto");
    }
  }

  assert.deepEqual(
    [...observedLines].filter(lines => lines >= 2 && lines <= 5).sort(),
    [2, 3, 4, 5],
  );

  await page.setViewportSize({ width: 660, height: 900 });
  await replaceInput(page, "第一行\n第二行\n第三行\n第四行\n第五行");
  assertVisibleThroughFiveLines(await textareaMetrics(page), "explicit newlines");

  await replaceInput(page, "普通输入后应当缩回一行");
  const shortened = await textareaMetrics(page);
  assert.equal(shortened.requiredLines, 1);
  assertVisibleThroughFiveLines(shortened, "ordinary input and deletion");

  await replaceInput(
    page,
    "粘贴的较长文本需要随着当前可用宽度自动展开，同时保持全部内容可见。".repeat(2),
    "insertFromPaste",
  );
  assertVisibleThroughFiveLines(await textareaMetrics(page), "pasted text");

  await replaceInput(page, "/rev");
  await page.getByRole("button", { name: /\/review/ })
    .evaluate(button => button.click());
  await waitForLayout(page);
  const command = await textareaMetrics(page);
  assert.equal(command.value, "/review ");
  assertVisibleThroughFiveLines(command, "slash command completion");

  await replaceInput(page, "请检查 @composer");
  await page.getByRole("button", {
    name: /composer-autosize-browser-regression-notes\.md/,
  }).evaluate(button => button.click());
  await waitForLayout(page);
  const mention = await textareaMetrics(page);
  assert.match(mention.value, /@docs\/architecture\/composer-autosize/);
  assertVisibleThroughFiveLines(mention, "workspace mention completion");
}

try {
  await run();
  console.log("[composer-autosize-browser] PASS");
} catch (error) {
  console.error(error?.stack ?? error);
  if (serviceOutput.length > 0) console.error(serviceOutput.join(""));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stopService(vite).catch(() => {});
}
