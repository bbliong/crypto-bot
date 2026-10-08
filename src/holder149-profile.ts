import { cp, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

const exec = promisify(execFile);
const excluded = new Set(['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'ShaderCache', 'GrShaderCache', 'GraphiteDawnCache', 'Sessions', 'LOCK', 'lockfile']);
async function inUse(directory: string) {
  if (process.platform === 'win32') {
    const match = (`--user-data-dir=${directory}`).replaceAll("'", "''");
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('"','').Contains('${match}') }).Count`], { windowsHide: true });
    return Number(stdout.trim()) > 0;
  }
  const { stdout } = await exec('ps', ['-ax', '-o', 'args=']);
  return stdout.split('\n').some(line => /chrome|chromium/i.test(line) && line.replaceAll('"', '').includes(`--user-data-dir=${directory}`));
}
export async function prepareHolder149Profile({ root = process.cwd(), sourceName = 'buy-sell-watch',
  isInUse = inUse }: { root?: string; sourceName?: string; isInUse?: (path: string) => Promise<boolean> } = {}) {
  if (!/^[a-z0-9-]+$/.test(sourceName) || sourceName === 'holder149-watch') throw new Error('Profil sumber tidak valid.');
  const profiles = resolve(root, 'profiles'), source = join(profiles, sourceName), destination = join(profiles, 'holder149-watch');
  const profileName = 'Profile 12';
  const check = (path: string) => {
    const rel = relative(profiles, resolve(path));
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || (existsSync(path) && lstatSync(path).isSymbolicLink()))
      throw new Error('Path profil harus berada di profiles project dan bukan symlink.');
  };
  check(source); check(destination); check(join(source, profileName));
  if (existsSync(join(destination, 'login-source.json')) && existsSync(join(destination, 'Local State')) && existsSync(join(destination, profileName)))
    return { profileDir: destination, profileName, imported: false };
  if (await isInUse(source) || await isInUse(destination)) throw new Error('Profil login sumber/tujuan sedang dipakai. Tutup Chrome terkait sebelum menyalin.');
  if (!existsSync(join(source, profileName, 'Network', 'Cookies')) && !existsSync(join(source, profileName, 'Cookies')))
    throw new Error(`Database login ${sourceName}/Profile 12 tidak ditemukan.`);
  const localState = await readFile(join(source, 'Local State'));
  JSON.parse(localState.toString());
  await mkdir(profiles, { recursive: true });
  const staging = await mkdtemp(join(profiles, '.holder149-profile-'));
  check(staging);
  // No cookie values are read, decrypted, or printed.
  await writeFile(join(staging, 'Local State'), localState);
  await cp(join(source, profileName), join(staging, profileName), { recursive: true, force: false, errorOnExist: true,
    filter: path => !excluded.has(basename(path)) && !basename(path).startsWith('Singleton') && !lstatSync(path).isSymbolicLink() });
  const backupDir = existsSync(destination) ? `${destination}.backup-${Date.now()}` : undefined;
  if (backupDir) check(backupDir);
  await writeFile(join(staging, 'login-source.json'), JSON.stringify({ sourceProfileDir: source, profileName, importedAt: new Date().toISOString(), backupDir }, null, 2));
  if (backupDir) await rename(destination, backupDir);
  try { await rename(staging, destination); }
  catch (error) { if (backupDir) await rename(backupDir, destination); throw error; }
  return { profileDir: destination, profileName, imported: true, backupDir };
}
