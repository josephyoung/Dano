#!/usr/bin/env node
// Explicit preparation only. Startup and memory requests never download assets.
import { mkdir, lstat, readFile, realpath, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function installMemoryTokenizers(directory, catalog, download = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok || Number(response.headers.get('content-length')) > 67108864) throw Error();
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; if (size > 67108864) throw Error(); chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}) {
  const base = await lstat(directory);
  if (!base.isDirectory() || base.uid !== process.getuid() || (base.mode & 0o077)
    || await realpath(directory) !== resolve(directory)) throw Error('UNPROTECTED_TOKENIZER_DIRECTORY');
  for (const entry of catalog) {
    const target = join(directory, 'tokenizers', entry.revision);
    await mkdir(target, { recursive: true, mode: 0o700 });
    if (await realpath(target) !== target) throw Error('UNPROTECTED_TOKENIZER_DIRECTORY');
    for (const name of ['tokenizer.json', 'tokenizer_config.json']) {
      const path = join(target, name);
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 67108864
          || createHash('sha256').update(await readFile(path)).digest('hex') !== entry[name]) throw Error('MEMORY_TOKENIZER_HASH_MISMATCH');
        continue;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const bytes = await download(`https://huggingface.co/${entry.repository}/resolve/${entry.revision}/${name}`);
      if (bytes.length > 67108864 || createHash('sha256').update(bytes).digest('hex') !== entry[name]) throw Error('MEMORY_TOKENIZER_HASH_MISMATCH');
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, path); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    }
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw Error();
    const { memoryTokenizerCatalog } = await import('../dist/server/bridge/effective-memory-config.js');
    await installMemoryTokenizers(resolve(process.argv[2]), memoryTokenizerCatalog);
    console.log('MEMORY_TOKENIZERS_VERIFIED');
  } catch { console.error('MEMORY_TOKENIZER_PREPARATION_FAILED'); process.exitCode = 1; }
}
