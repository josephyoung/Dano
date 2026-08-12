#!/usr/bin/env node
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const marker = process.argv[2] ?? "";
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(marker)) {
  throw new Error("release marker is invalid");
}

const releasePath = join(dirname(import.meta.filename), "releases", marker);
const deadline = Date.now() + 5 * 60 * 1000;
while (!existsSync(releasePath)) {
  if (Date.now() >= deadline) throw new Error("release marker timed out");
  await wait(100);
}
console.log(`released ${basename(releasePath)}`);
