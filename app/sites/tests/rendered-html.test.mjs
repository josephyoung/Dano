import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("https://xiaoluo.example/", {
      headers: {
        accept: "text/html",
        host: "xiaoluo.example",
        "x-forwarded-host": "xiaoluo.example",
        "x-forwarded-proto": "https",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Xiaoluo assistant product site", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>小络助手 — 一句话完成跨系统业务办理<\/title>/);
  assert.match(html, /一句话，完成/);
  assert.match(html, /跨系统业务办理/);
  assert.match(html, /从一段对话，/);
  assert.match(html, /形成可追踪的业务结果/);
  assert.match(html, /酒店申请只是一个示例/);
  assert.match(html, /现有系统保持不变/);
  assert.match(html, /老旧系统也能快速接入/);
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("ships the complete production-demo flow and share metadata", async () => {
  const response = await render();
  const html = await response.text();

  for (const image of [
    "xiaoluo-logo.png",
    "start-input.jpg",
    "application-form.jpg",
    "confirm.jpg",
    "result.jpg",
    "og.png",
  ]) {
    await access(new URL(`../public/${image}`, import.meta.url));
  }

  assert.match(html, /员工发起/);
  assert.match(html, /申请信息自动生成/);
  assert.match(html, /员工核对并确认/);
  assert.match(html, /结果回到对话/);
  assert.match(html, /https:\/\/xiaoluo\.example\/og\.png/);
  assert.match(html, /property="og:image:width" content="1200"/);
  assert.match(html, /property="og:image:height" content="630"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
});
