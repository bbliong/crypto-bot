import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Supports both legacy run/*.jsonl and the new run/chunks/<WIB time>/*.jsonl.
export function listRunLogFiles(runDirectory, name) {
  if (!/^[a-z0-9-]+\.jsonl$/.test(name)) throw new Error('Invalid log filename.');
  const files = [];
  const legacy = join(runDirectory, name);
  if (existsSync(legacy)) files.push(legacy);
  const chunks = join(runDirectory, 'chunks');
  if (existsSync(chunks)) {
    for (const entry of readdirSync(chunks, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(chunks, entry.name, name);
      if (existsSync(path)) files.push(path);
    }
  }
  return files;
}

export function* readRunLogRecords(runDirectory, name) {
  for (const path of listRunLogFiles(runDirectory, name)) {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      yield record;
    }
  }
}
