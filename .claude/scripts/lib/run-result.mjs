// Machine-readable result of one headless run: which workspace files it changed, which ledger records it appended,
// which findings those include, and the validation result. A hosted harness reads this instead of parsing the
// session's closing prose. Only paths, ids, counts and record metadata are reported; never file contents,
// credentials or environment values.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redactSecrets } from './sandbox/redact.mjs';

export const SESSION_DIR = 'kpis/data/raw/sessions/';
const LEDGER_HEAD_BYTES = 4096;

export const ledgerPath = (companyId) => `company-profile/${companyId}/soc/main.jsonl`;

// Resolves symbolic links in the longest existing prefix of a path, so a link anywhere above the target counts.
function realish(path) {
  let head = resolve(path);
  const tail = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(basename(head));
    head = up;
  }
  let real = head;
  try { real = realpathSync(head); } catch { /* keep the resolved path */ }
  return join(real, ...tail);
}

export function isOutside(root, path) {
  const rel = relative(realish(root), realish(path));
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function run(args, root) {
  return spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
}

// Workspace files git reports as changed or untracked, each with a signature (status, size, mtime) so a file that
// was already dirty before the run and changed again is still noticed. Paths are relative to the workspace root even
// when it is a folder inside a larger repository. Returns Map<path, signature> or null outside a git checkout.
export function workspaceSnapshot(root = '.') {
  const prefixRes = run(['rev-parse', '--show-prefix'], root);
  if (prefixRes.status !== 0) return null;
  const prefix = prefixRes.stdout.trim();
  const r = run(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], root);
  if (r.status !== 0) return null;
  const local = (p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const snap = new Map();
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = local(entry.slice(3));
    let sig = code;
    if (code[0] === 'R' || code[0] === 'C') {
      // -z puts the original path of a rename or copy in the next field; a rename also changed that path.
      const from = local(parts[i + 1] || '');
      i += 1;
      sig += `<${from}`;
      if (code[0] === 'R' && from) snap.set(from, `R>${path}`);
    }
    try { const st = statSync(join(root, path)); sig += `:${st.size}:${st.mtimeMs}`; } catch { sig += ':deleted'; }
    snap.set(path, sig);
  }
  return snap;
}

// Paths whose state differs between two snapshots (new, changed again, deleted, renamed, or reverted to clean),
// split into workspace files and the session KPI files every run writes under kpis/data/raw/sessions/.
export function changedFiles(before, after) {
  if (!before || !after) return { files: null, sessionFiles: null };
  const paths = new Set();
  for (const [p, sig] of after) if (before.get(p) !== sig) paths.add(p);
  for (const p of before.keys()) if (!after.has(p)) paths.add(p);
  const sorted = [...paths].sort();
  return { files: sorted.filter((p) => !p.startsWith(SESSION_DIR)), sessionFiles: sorted.filter((p) => p.startsWith(SESSION_DIR)) };
}

function readRange(file, start, length) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
}

const hashOf = (buf) => createHash('sha256').update(buf).digest('hex');

// The ledger is append-only: its state before the run is its size and a hash of its first bytes.
export function ledgerState(file) {
  if (!existsSync(file)) return { size: 0, headHash: hashOf(Buffer.alloc(0)) };
  const size = statSync(file).size;
  return { size, headHash: hashOf(readRange(file, 0, Math.min(size, LEDGER_HEAD_BYTES))) };
}

// Returns { text } with the bytes appended since `before`, or { rewritten: true } when the file shrank or its first
// bytes changed (it was rewritten rather than appended to, so an offset means nothing).
export function ledgerAppended(file, before) {
  if (!existsSync(file)) return before.size === 0 ? { text: '' } : { rewritten: true };
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < before.size) return { rewritten: true };
    const headLen = Math.min(before.size, LEDGER_HEAD_BYTES);
    const head = Buffer.alloc(headLen);
    readSync(fd, head, 0, headLen, 0);
    if (hashOf(head) !== before.headHash) return { rewritten: true };
    const buf = Buffer.alloc(size - before.size);
    readSync(fd, buf, 0, buf.length, before.size);
    return { text: buf.toString('utf8') };
  } finally { closeSync(fd); }
}

const redact = (v) => (typeof v === 'string' ? redactSecrets(v).text : v);

// text: the appended JSONL. Returns { ledger: {appended, byKind, ids, unparsable}, findings: [...] }.
export function summarizeLedger(text) {
  const byKind = {}; const ids = []; const findings = []; let appended = 0; let unparsable = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { unparsable += 1; continue; }
    appended += 1;
    const kind = typeof rec.kind === 'string' ? rec.kind : 'unknown';
    byKind[kind] = (byKind[kind] || 0) + 1;
    if (typeof rec.id === 'string') ids.push(rec.id);
    if (kind === 'finding') {
      const picked = { id: rec.id, title: redact(rec.title), severity: rec.severity, status: rec.status, fingerprint: rec.fingerprint, supersedes: rec.supersedes, slaDueAt: rec.slaDueAt, firstSeenAt: rec.firstSeenAt, lastSeenAt: rec.lastSeenAt };
      findings.push(Object.fromEntries(Object.entries(picked).filter(([, v]) => v !== undefined)));
    }
  }
  return { ledger: { appended, byKind, ids, unparsable }, findings };
}

// Runs `npm run validate` and keeps its exit code and a short tail of its output, redacted before it is cut.
export function runValidation(root = '.', { npm = 'npm', tailLines = 15 } = {}) {
  const r = spawnSync(npm, ['run', '-s', 'validate'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
  const redacted = redactSecrets(`${r.stdout || ''}${r.stderr || ''}`).text;
  const lines = redacted.split('\n').filter((l) => l.trim() && !l.startsWith('strict mode:'));
  return { ran: true, ok: r.status === 0, exitCode: r.status === null ? null : r.status, tail: lines.slice(-tailLines).join('\n').slice(-3000) };
}

// The result file is runtime state for the caller, so it must live outside the workspace.
export function checkResultPath(path, root = '.') {
  if (!path) return null;
  const abs = resolve(root, path);
  if (!isOutside(root, abs)) return `--result-file must be outside the workspace (${abs} is inside ${resolve(root)})`;
  if (!existsSync(dirname(abs))) return `--result-file directory ${dirname(abs)} does not exist`;
  return null;
}

// Written to a new, unpredictable temporary file in the target directory (created exclusively, mode 0600), then
// renamed over the target, so a reader never sees a partial result.
export function writeResultFile(path, doc, root = '.') {
  const abs = resolve(root, path);
  const tmp = join(dirname(abs), `.${basename(abs)}.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    try { writeSync(fd, JSON.stringify(doc, null, 2) + '\n'); } finally { closeSync(fd); }
    renameSync(tmp, abs);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw err;
  }
  return abs;
}
