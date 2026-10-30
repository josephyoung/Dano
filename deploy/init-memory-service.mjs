#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, lstat, realpath, readdir, link, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const fail = () => new Error('MEMORY_CONFIG_INITIALIZATION_FAILED');
async function finishPublication(path, file) {
  let stat = await file.stat();
  if (stat.nlink !== 2) return;
  const directory = dirname(path);
  for (const name of await readdir(directory)) {
    if (!/^\.memory-secrets\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(name)) continue;
    const temporary = join(directory, name);
    const candidate = await lstat(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    // Recover only this publisher's second name for the very same private inode.
    if (candidate?.isFile() && candidate.dev === stat.dev && candidate.ino === stat.ino) {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
      break;
    }
  }
  stat = await file.stat();
  if (stat.nlink !== 1) throw fail();
}
async function privateJson(path, recoverPublication = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    let stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 1048576) throw fail();
    if (recoverPublication) { await finishPublication(path, file); stat = await file.stat(); }
    if (stat.nlink !== 1) throw fail();
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

/** Initializes only a missing file. Existing settings and credentials are never merged or rewritten. */
export async function initializeMemoryService(directory, validate) {
  try {
    if (await realpath(directory) !== resolve(directory)) throw fail();
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw fail();
    const target = join(directory, 'memory-secrets.json');
    try {
      const existing = await privateJson(target, true);
      validate(existing);
      return 'MEMORY_CONFIG_PRESERVED';
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const input = await privateJson(join(directory, 'memory-secrets.inputs.json'));
    const config = input;
    validate(config); // Missing credentials/assets fail before publishing anything.
    const temporary = join(directory, `.memory-secrets.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(config, null, 2) + '\n');
        await file.sync();
      } finally { await file.close(); }
      // Atomic no-replace publication: a concurrent initializer cannot overwrite a winner.
      await link(temporary, target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      validate(await privateJson(target, true));
      return 'MEMORY_CONFIG_PRESERVED';
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    return 'MEMORY_CONFIG_INITIALIZED';
  } catch { throw fail(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw fail();
    const { parseMemorySecrets } = await import('../dist/server/bridge/effective-memory-config.js');
    console.log(await initializeMemoryService(process.argv[2], parseMemorySecrets));
  } catch { console.error('MEMORY_CONFIG_INITIALIZATION_FAILED'); process.exitCode = 1; }
}
