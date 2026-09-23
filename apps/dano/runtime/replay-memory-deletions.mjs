#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { OwnerMemoryClient } from "@josephyoung/pi-openviking/host";
import { MemoryCredentialStore } from "./dist/server/bridge/memory-credential-store.js";

// Run with Dano stopped. The post-snapshot ledger and owner state must come
// from outside the older backup being restored. Never print either secret.
let stage = "arguments";
try {
  const [configDirectory, dataDirectory, ledgerFile, ...extra] = process.argv.slice(2);
  assert.ok(configDirectory && dataDirectory && ledgerFile && extra.length === 0, "INVALID_ARGUMENTS");
  stage = "load";
  const ledger = JSON.parse(await readFile(ledgerFile, "utf8"));
  const config = JSON.parse(await readFile(resolve(configDirectory, "memory", "memory-service.json"), "utf8"));
  assert.equal(ledger.version, 1, "INVALID_LEDGER");
  assert.equal(config.accountId, ledger.owner?.accountId, "OWNER_MISMATCH");
  assert.ok(/^[A-Za-z0-9_-]{1,128}$/.test(ledger.owner?.userId), "INVALID_LEDGER");
  assert.ok(Array.isArray(ledger.deleteUris) && Array.isArray(ledger.sourceSessionIds)
    && Array.isArray(ledger.expectedDocumentUris) && ledger.retainedDocuments
    && typeof ledger.retainedDocuments === "object" && !Array.isArray(ledger.retainedDocuments), "INVALID_LEDGER");
  assert.ok(typeof ledger.statePath === "string" && ledger.statePath.split("/").every(part => part && part !== "." && part !== ".."), "INVALID_LEDGER");
  const owner = ledger.owner;
  const root = `viking://user/${owner.userId}/memories/`;
  const uris = [...ledger.deleteUris, ...ledger.expectedDocumentUris, ...Object.keys(ledger.retainedDocuments)];
  assert.ok(uris.every(uri => typeof uri === "string" && uri.startsWith(root) && uri.endsWith(".md")), "INVALID_LEDGER");
  assert.ok(ledger.sourceSessionIds.every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id)), "INVALID_LEDGER");
  assert.ok(Object.values(ledger.retainedDocuments).every(value => typeof value === "string" && value.trim()), "INVALID_LEDGER");
  assert.ok(ledger.expectedDocumentUris.every(uri => !ledger.deleteUris.includes(uri)), "INVALID_LEDGER");
  const statePath = resolve(dataDirectory, ledger.statePath);
  assert.ok(statePath.startsWith(`${resolve(dataDirectory)}${sep}`), "INVALID_LEDGER");
  assert.equal(createHash("sha256").update(await readFile(statePath)).digest("hex"), ledger.postStateSha256,
    "POST_SNAPSHOT_STATE_MISMATCH");

  stage = "credential";
  const credentials = new MemoryCredentialStore({
    directory: resolve(dataDirectory, "host-state", "memory-service", "credentials"),
    encryptionKey: Buffer.from(config.encryptionKey, "hex"),
    keyVersion: config.encryptionKeyVersion,
  });
  const key = await credentials.read(owner);
  assert.ok(key, "CREDENTIAL_MISSING");
  const client = new OwnerMemoryClient({ owner, baseUrl: config.baseUrl, apiKey: key, scope: null,
    timeoutMs: config.requestTimeoutMs });

  stage = "replay";
  await client.verifyIdentity();
  for (const remoteSessionId of ledger.sourceSessionIds) await client.removeSource({ owner, scope: null, remoteSessionId });
  for (const uri of ledger.deleteUris) await client.removeMemory(uri);
  for (const [uri, content] of Object.entries(ledger.retainedDocuments)) await client.replaceMemory(uri, content);

  stage = "readback";
  for (const remoteSessionId of ledger.sourceSessionIds) assert.equal(await client.sessionExists(remoteSessionId), false, "SOURCE_RESTORED");
  for (const [uri, content] of Object.entries(ledger.retainedDocuments)) {
    assert.equal(await client.readMemory(uri), content, "RETAINED_DOCUMENT_MISMATCH");
  }
  assert.deepEqual(await client.listMemoryDocuments(), [...ledger.expectedDocumentUris].sort(), "DOCUMENT_SET_MISMATCH");
  process.stdout.write(JSON.stringify({ result: "passed", deletedUris: ledger.deleteUris.length,
    removedSources: ledger.sourceSessionIds.length, retainedDocuments: Object.keys(ledger.retainedDocuments).length,
    expectedDocuments: ledger.expectedDocumentUris.length }) + "\n");
} catch (error) {
  const firstLine = error instanceof Error ? error.message.split("\n", 1)[0] : "";
  const code = /^[A-Z][A-Z0-9_]*$/.test(firstLine) ? firstLine : "REPLAY_FAILED";
  process.stderr.write(JSON.stringify({ result: "failed", stage, code }) + "\n");
  process.exitCode = 1;
}
