import { afterEach, expect, it } from 'vitest';
import { chmod, link, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeMemoryService } from '../../../../../deploy/init-memory-service.mjs';
import { parseMemorySecrets } from '../effective-memory-config.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const inputs = () => ({ accountId: 'synthetic-account', managementKey: 'synthetic-management', encryptionKey: 'ab'.repeat(32),
  encryptionKeyVersion: 'v1' });
async function setup(input: unknown = inputs()) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'memory-init-'))); roots.push(dir);
  await writeFile(join(dir, 'memory-secrets.inputs.json'), JSON.stringify(input), { mode: 0o600 });
  return dir;
}
it('initializes only secrets without another functional/model configuration', async () => {
  const dir = await setup();
  expect(await initializeMemoryService(dir, parseMemorySecrets)).toBe('MEMORY_CONFIG_INITIALIZED');
  const path = join(dir, 'memory-secrets.json'), raw = JSON.parse(await readFile(path, 'utf8'));
  expect(raw).toEqual(inputs());
  expect(raw).not.toHaveProperty('memoryModel');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});
it('preserves existing settings, credentials, bytes and inode without reading bootstrap inputs', async () => {
  const dir = await setup(); await initializeMemoryService(dir, parseMemorySecrets);
  const path = join(dir, 'memory-secrets.json'), config = JSON.parse(await readFile(path, 'utf8'));
  config.managementKey = "rotated-synthetic-management";
  const bytes = JSON.stringify(config) + '\n\n'; await writeFile(path, bytes);
  await rm(join(dir, 'memory-secrets.inputs.json'));
  const before = await stat(path);
  expect(await initializeMemoryService(dir, parseMemorySecrets)).toBe('MEMORY_CONFIG_PRESERVED');
  expect(await readFile(path, 'utf8')).toBe(bytes);
  expect((await stat(path)).ino).toBe(before.ino);
});
it('fails without publishing when required inputs or schema are invalid, without leaking values', async () => {
  for (const input of [{}, { ...inputs(), accidentalSecret: 'do-not-print-me' }]) {
    const dir = await setup(input);
    await expect(initializeMemoryService(dir, parseMemorySecrets)).rejects.toThrow(/^MEMORY_CONFIG_INITIALIZATION_FAILED$/);
    await expect(stat(join(dir, 'memory-secrets.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }
});
it('does not repair or overwrite corrupt existing files', async () => {
  const dir = await setup(), path = join(dir, 'memory-secrets.json');
  await writeFile(path, 'corrupt-private-config', { mode: 0o600 });
  await expect(initializeMemoryService(dir, parseMemorySecrets)).rejects.toThrow('MEMORY_CONFIG_INITIALIZATION_FAILED');
  expect(await readFile(path, 'utf8')).toBe('corrupt-private-config');
});
it('rejects unsafe bootstrap permissions and symlink destinations', async () => {
  const dir = await setup(), seed = join(dir, 'memory-secrets.inputs.json');
  await chmod(seed, 0o644);
  await expect(initializeMemoryService(dir, parseMemorySecrets)).rejects.toThrow('MEMORY_CONFIG_INITIALIZATION_FAILED');
  await chmod(seed, 0o600);
  await symlink(seed, join(dir, 'memory-secrets.json'));
  await expect(initializeMemoryService(dir, parseMemorySecrets)).rejects.toThrow('MEMORY_CONFIG_INITIALIZATION_FAILED');
  expect(JSON.parse(await readFile(seed, 'utf8'))).toEqual(inputs());
});
it('recovers an interrupted publication without rewriting the configuration or credentials', async () => {
  const dir = await setup(); await initializeMemoryService(dir, parseMemorySecrets);
  const target = join(dir, 'memory-secrets.json');
  const before = await readFile(target, 'utf8'), inode = (await stat(target)).ino;
  const temporary = join(dir, '.memory-secrets.00000000-0000-4000-8000-000000000001.tmp');
  await link(target, temporary); // Crash after publication, before temporary unlink.
  await rm(join(dir, 'memory-secrets.inputs.json'));
  expect(await initializeMemoryService(dir, parseMemorySecrets)).toBe('MEMORY_CONFIG_PRESERVED');
  expect(await readFile(target, 'utf8')).toBe(before);
  expect(await stat(target)).toMatchObject({ ino: inode, nlink: 1 });
  await expect(stat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('does not remove unrelated hardlinks or publisher-looking files', async () => {
  const dir = await setup(); await initializeMemoryService(dir, parseMemorySecrets);
  const target = join(dir, 'memory-secrets.json'), other = join(dir, 'unrelated-link');
  const temporary = join(dir, '.memory-secrets.00000000-0000-4000-8000-000000000002.tmp');
  await link(target, other); await writeFile(temporary, 'unrelated', { mode: 0o600 });
  await expect(initializeMemoryService(dir, parseMemorySecrets)).rejects.toThrow('MEMORY_CONFIG_INITIALIZATION_FAILED');
  expect((await stat(target)).nlink).toBe(2);
  expect(await readFile(temporary, 'utf8')).toBe('unrelated');
});
it('concurrent initializers publish once and preserve the winning configuration', async () => {
  const dir = await setup();
  const results = await Promise.all(Array.from({ length: 8 }, () => initializeMemoryService(dir, parseMemorySecrets)));
  expect(results.filter(result => result === 'MEMORY_CONFIG_INITIALIZED')).toHaveLength(1);
  expect(results.filter(result => result === 'MEMORY_CONFIG_PRESERVED')).toHaveLength(7);
  expect((await stat(join(dir, 'memory-secrets.json'))).nlink).toBe(1);
});
