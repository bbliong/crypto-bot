import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareHolder149Profile } from '../src/holder149-profile.js';

test('new profile copies login once, excludes cache, preserves source and reuses separate destination', async () => {
  const root = mkdtempSync(join(tmpdir(), 'holder149-profile-'));
  const source = join(root, 'profiles', 'buy-sell-watch'), target = join(root, 'profiles', 'holder149-watch');
  mkdirSync(join(source, 'Profile 12', 'Network'), { recursive: true });
  mkdirSync(join(source, 'Profile 12', 'Cache'));
  writeFileSync(join(source, 'Local State'), '{"test":true}');
  writeFileSync(join(source, 'Profile 12', 'Network', 'Cookies'), 'fixture-cookie-db');
  writeFileSync(join(source, 'Profile 12', 'Cache', 'ignored'), 'cache');
  try {
    const first = await prepareHolder149Profile({ root, isInUse: async () => false });
    assert.equal(first.imported, true); assert.equal(first.profileDir, target);
    assert.equal(readFileSync(join(target, 'Local State'), 'utf8'), '{"test":true}');
    assert.equal(readFileSync(join(target, 'Profile 12', 'Network', 'Cookies'), 'utf8'), 'fixture-cookie-db');
    assert.equal(existsSync(join(target, 'Profile 12', 'Cache')), false);
    assert.equal((await prepareHolder149Profile({ root, isInUse: async () => true })).imported, false);
    assert.equal(readFileSync(join(source, 'Profile 12', 'Network', 'Cookies'), 'utf8'), 'fixture-cookie-db');
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('new profile refuses an active source before copying; source names cannot escape profiles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'holder149-profile-busy-'));
  try {
    await assert.rejects(prepareHolder149Profile({ root, isInUse: async () => true }), /sedang dipakai/);
    assert.equal(existsSync(join(root, 'profiles', 'holder149-watch')), false);
    await assert.rejects(prepareHolder149Profile({ root, sourceName: '../escape' }), /tidak valid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
