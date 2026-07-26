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

function actionMetrics(page) {
  return page.evaluate(() => {
    const sections = [...document.querySelectorAll("main > section")];
    const submitted = document.querySelector(".submitted-fields");
    return {
      viewportWidth: innerWidth,
      cards: sections.map(section => {
        const actions = section.querySelector(".question-actions");
        const buttons = [...section.querySelectorAll(
          ".question-actions .question-button",
        )];
        if (!actions || buttons.length === 0) {
          throw new Error("question action row is missing");
        }
        const actionHeight = actions.getBoundingClientRect().height;
        const buttonHeights = buttons.map(button =>
          button.getBoundingClientRect().height
        );
        const style = getComputedStyle(buttons[0]);
        return {
          actionHeight,
          buttonHeights,
          bottomBlank: actionHeight - Math.max(...buttonHeights),
          paddingBlock: [style.paddingBlockStart, style.paddingBlockEnd],
          paddingInline: [style.paddingInlineStart, style.paddingInlineEnd],
          display: style.display,
          alignItems: style.alignItems,
          justifyContent: style.justifyContent,
        };
      }),
      inputHeight: document.querySelector(".question-input:not(textarea)")
        ?.getBoundingClientRect().height,
      submittedGridColumns: submitted
        ? getComputedStyle(submitted).gridTemplateColumns
        : null,
    };
  });
}

function assertActionMetrics(metrics, height) {
  assert.equal(metrics.inputHeight, height);
  for (const card of metrics.cards) {
    assert.deepEqual(card.buttonHeights, card.buttonHeights.map(() => height));
    assert.equal(card.actionHeight, height);
    assert.equal(card.bottomBlank, 0);
    assert.deepEqual(card.paddingBlock, ["0px", "0px"]);
    assert.deepEqual(card.paddingInline, ["14px", "14px"]);
    assert.equal(card.display, "flex");
    assert.equal(card.alignItems, "center");
    assert.equal(card.justifyContent, "center");
  }
}

function mobileDateArrowMetrics(page) {
  return page.evaluate(() => {
    const control = document.querySelector(".question-date-native-control");
    const input = control?.querySelector(".question-date-native");
    const icon = control?.querySelector(".question-date-native-icon");
    if (!control || !input || !icon) {
      throw new Error("mobile native date control is missing");
    }
    const rect = icon.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    return {
      icons: control.querySelectorAll(".question-date-native-icon").length,
      svgs: control.querySelectorAll(".question-date-native-icon svg").length,
      pointerEvents: getComputedStyle(icon).pointerEvents,
      hitIsInput: hit === input,
    };
  });
}

async function visibleForegrounds(page) {
  return page.evaluate(() => ({
    token: getComputedStyle(document.documentElement)
      .getPropertyValue("--on-accent").trim(),
    primaryButtons: [...document.querySelectorAll(
      "main > section .question-actions .question-button:not(.secondary)",
    )].map(button => getComputedStyle(button).color),
    submittedIcon: getComputedStyle(
      document.querySelector(".submitted-status-icon"),
    ).color,
  }));
}

async function accentSurfaceForegrounds(page) {
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "日期", exact: true }).click();
  const enabledDays = page.locator(
    ".question-calendar-day:not([data-disabled]):not([data-unavailable])",
  );
  assert.ok(await enabledDays.count() > 0);
  await enabledDays.first().click();
  await page.getByRole("button", { name: "日期", exact: true }).click();
  return page.evaluate(() => {
    const checkbox = document.querySelector(
      '.question-option input[type="checkbox"]:checked',
    );
    const day = document.querySelector(".question-calendar-day[data-selected]");
    if (!checkbox || !day) throw new Error("accent surface is not visible");
    return {
      checkbox: getComputedStyle(checkbox, "::before").borderBottomColor,
      selectedDate: getComputedStyle(day).color,
    };
  });
}

async function inlineFormOverflowMetrics(page) {
  return page.evaluate(() => {
    const ancestor = document.querySelector(
      '[data-testid="inline-form-overflow-ancestor"]',
    );
    const transcript = ancestor?.querySelector(".chat-transcript");
    const scrollRegion = ancestor?.querySelector(".question-form-scroll-region");
    if (!ancestor || !transcript || !scrollRegion) {
      throw new Error("inline form overflow harness is missing");
    }
    return {
      transcriptClientHeight: transcript.clientHeight,
      transcriptScrollHeight: transcript.scrollHeight,
      scrollRegionClientHeight: scrollRegion.clientHeight,
      scrollRegionScrollHeight: scrollRegion.scrollHeight,
    };
  });
}

async function transcriptPositionMetrics(page) {
  return page.evaluate(() => {
    const transcript = document.querySelector(".chat-transcript");
    const card = document.querySelector(".question-card");
    if (!transcript || !card) {
      throw new Error("center focus scroll harness is missing");
    }
    const transcriptRect = transcript.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return {
      scrollTop: transcript.scrollTop,
      maxScrollTop: transcript.scrollHeight - transcript.clientHeight,
      transcriptTop: transcriptRect.top,
      transcriptBottom: transcriptRect.bottom,
      cardTop: cardRect.top,
      cardBottom: cardRect.bottom,
    };
  });
}

async function assertFocusReturnKeepsPosition(
  browser,
  origin,
  { terminalState = "answered", viewport = { width: 1280, height: 720 } } = {},
) {
  const page = await browser.newPage({
    viewport,
  });
  try {
    await page.goto(
      `${origin}/center-focus-scroll-test.html?state=${terminalState}`,
      {
        waitUntil: "domcontentloaded",
      },
    );
    await page.locator(".center-focused-card").waitFor();
    await page.getByTestId("resolve-focus-card").click();
    await page.locator(".center-focused-card").waitFor({ state: "detached" });
    const restored = await transcriptPositionMetrics(page);
    await page.locator(".chat-transcript").dispatchEvent("scroll");

    await page.getByTestId("grow-final-response").click();
    await page.getByText("用于验证居中卡片返回聊天流后长内容增长不会改变阅读位置的详细说明 28", {
      exact: true,
    }).waitFor();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const grown = await transcriptPositionMetrics(page);

    assert.ok(
      Math.abs(grown.scrollTop - restored.scrollTop) <= 1,
      `${terminalState}: expected scrollTop to stay at ${restored.scrollTop}, got ${grown.scrollTop}`,
    );
    assert.ok(grown.cardBottom > grown.transcriptTop);
    assert.ok(grown.cardTop < grown.transcriptBottom);
    assert.ok(grown.scrollTop < grown.maxScrollTop);

    await page.getByRole("button", { name: "滚动到底部", exact: true }).click();
    await page.waitForFunction(() => {
      const transcript = document.querySelector(".chat-transcript");
      return transcript &&
        transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 1;
    });
    await page.getByTestId("continue-final-response").click();
    await page.getByText("回复继续增长。", { exact: true }).waitFor();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const continued = await transcriptPositionMetrics(page);
    assert.ok(
      Math.abs(continued.maxScrollTop - continued.scrollTop) <= 1,
      `${terminalState}: expected explicit bottom navigation to resume automatic following`,
    );
  } finally {
    await page.close();
  }
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
  await waitForHttp(`${origin}/question-tool-card-test.html`, { services: [vite] });

  browser = await chromium.launch({ executablePath, headless: true });
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ]) {
    for (const terminalState of [
      "answered",
      "cancelled",
      "confirmed",
      "interrupted",
    ]) {
      await assertFocusReturnKeepsPosition(browser, origin, {
        terminalState,
        viewport,
      });
    }
  }
  const page = await browser.newPage({ viewport: { width: 641, height: 900 } });
  await page.goto(`${origin}/question-tool-card-test.html?accent=gray`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("button", { name: "提交", exact: true }).waitFor();

  const desktop = await actionMetrics(page);
  assert.equal(desktop.viewportWidth, 641);
  assertActionMetrics(desktop, 36);
  assert.equal(desktop.submittedGridColumns.split(" ").length, 2);
  const inlineOverflow = await inlineFormOverflowMetrics(page);
  assert.ok(
    inlineOverflow.scrollRegionScrollHeight > inlineOverflow.scrollRegionClientHeight,
  );
  assert.equal(
    inlineOverflow.transcriptScrollHeight,
    inlineOverflow.transcriptClientHeight,
  );

  const gray = await visibleForegrounds(page);
  assert.equal(gray.token, "#ffffff");
  assert.deepEqual(gray.primaryButtons, ["rgb(255, 255, 255)", "rgb(255, 255, 255)"]);
  assert.equal(gray.submittedIcon, "rgb(255, 255, 255)");

  await page.setViewportSize({ width: 640, height: 900 });
  const narrow = await actionMetrics(page);
  assert.equal(narrow.viewportWidth, 640);
  assertActionMetrics(narrow, 44);
  assert.deepEqual(await mobileDateArrowMetrics(page), {
    icons: 1,
    svgs: 1,
    pointerEvents: "none",
    hitIsInput: true,
  });

  await page.setViewportSize({ width: 641, height: 900 });
  for (const [preset, expectedToken, expectedRgb] of [
    ["default", "#ffffff", "rgb(255, 255, 255)"],
    ["blue", "#ffffff", "rgb(255, 255, 255)"],
    ["gray", "#ffffff", "rgb(255, 255, 255)"],
    ["yellow", "#ffffff", "rgb(255, 255, 255)"],
    ["pink", "#ffffff", "rgb(255, 255, 255)"],
    ["purple", "#ffffff", "rgb(255, 255, 255)"],
  ]) {
    await page.goto(`${origin}/question-tool-card-test.html?accent=${preset}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("button", { name: "提交", exact: true }).waitFor();
    const foregrounds = await visibleForegrounds(page);
    assert.equal(foregrounds.token, expectedToken, preset);
    assert.deepEqual(foregrounds.primaryButtons, [expectedRgb, expectedRgb], preset);
    assert.equal(foregrounds.submittedIcon, expectedRgb, preset);
    assert.deepEqual(
      await accentSurfaceForegrounds(page),
      { checkbox: expectedRgb, selectedDate: expectedRgb },
      preset,
    );
  }
}

try {
  await run();
  console.log("[question-tool-card-browser] PASS");
} catch (error) {
  console.error(error?.stack ?? error);
  if (serviceOutput.length > 0) console.error(serviceOutput.join(""));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stopService(vite).catch(() => {});
}
