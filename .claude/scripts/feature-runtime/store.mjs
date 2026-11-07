import { mkdir, readdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { sha256 } from '../incident-investigation/core.mjs';

export const token = (v) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,254}$/.test(v);
export const slug = (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v);
export function requireValue(ok, message) { if (!ok) throw new Error(message); }
export function timestamp(now) { requireValue(Number.isSafeInteger(now) && now >= 0, 'invalid clock'); return new Date(now).toISOString(); }
export async function actor(authorize, session, companyId, permission) {
  requireValue(slug(companyId), 'invalid company');
  const principal = await authorize(session, companyId, permission);
  requireValue(principal?.companyId === companyId && token(principal.id), 'not authorized');
  return principal.id;
}
export const provenance = (sessionId, now, agent) => ({ harness: 'script', generatedAt: timestamp(now), workflow: 'manual', sessionId, agent });

// An immutable, CAS-versioned journal inside the existing sanctioned session-export layout.
// A competing writer can exclusively create a revision once. No lock expiry or ownership stealing.
export class ExportStateStore {
  constructor({ root = '.', sessionId, maxFiles = 10000 }) {
    requireValue(typeof sessionId === 'string' && /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|ses_[A-Za-z0-9]{6,64})$/.test(sessionId), 'invalid state session');
    this.root = resolve(root); this.directory = join(this.root, 'kpis/data/raw/sessions', sessionId);
    this.sessionId = sessionId; this.maxFiles = maxFiles;
  }
  async directoryReady() {
    // Reject symlinks in every directory component below the workspace root.
    let current = this.root;
    for (const part of relative(this.root, this.directory).split('/')) {
      current = join(current, part);
      await mkdir(current).catch((e) => { if (e.code !== 'EEXIST') throw e; });
      requireValue((await lstat(current)).isDirectory() && !(await lstat(current)).isSymbolicLink(), 'unsafe state directory');
    }
    requireValue((await realpath(this.directory)).startsWith((await realpath(this.root)) + '/'), 'unsafe state root');
  }
  key(companyId, key) { requireValue(slug(companyId) && token(key), 'invalid state identity'); return sha256([companyId, key]); }
  async get(companyId, key) {
    const prefix = this.key(companyId, key); await this.directoryReady();
    const files = await readdir(this.directory); requireValue(files.length <= this.maxFiles, 'state journal capacity exceeded');
    const names = files.filter((f) => f.startsWith(prefix + '.') && f.endsWith('.export.json')).sort();
    let previous = null;
    for (const name of names) {
      const file = join(this.directory, name); requireValue((await lstat(file)).isFile() && !(await lstat(file)).isSymbolicLink(), 'unsafe state file');
      const envelope = JSON.parse(await readFile(file, 'utf8')); const { digest, ...data } = envelope;
      requireValue(data.kind === 'maxwell.feature.state' && data.companyId === companyId && data.key === key
        && data.revision === (previous?.revision || 0) + 1 && data.previousDigest === (previous?.digest || null)
        && digest === sha256(data), 'corrupt state journal');
      previous = envelope;
    }
    return previous;
  }
  async change(companyId, key, previous, value, now = Date.now()) {
    const current = await this.get(companyId, key);
    requireValue((current?.digest || null) === (previous?.digest || null), 'state revision conflict');
    const revision = (current?.revision || 0) + 1;
    requireValue(revision <= 999999999, 'state revision exhausted');
    const data = { schemaVersion: '1', kind: 'maxwell.feature.state', companyId, key, revision,
      previousDigest: current?.digest || null, value: structuredClone(value), provenance: provenance(this.sessionId, now, 'feature-runtime') };
    const next = { ...data, digest: sha256(data) };
    try { await writeFile(join(this.directory, `${this.key(companyId, key)}.${String(revision).padStart(9, '0')}.export.json`), JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code === 'EEXIST') throw new Error('state revision conflict'); throw e; }
    return next;
  }
}
