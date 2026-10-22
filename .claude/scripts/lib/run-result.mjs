// Machine-readable result of one headless run: which workspace files it changed, which ledger records it appended,
// which findings those include, and the validation result. A hosted harness reads this instead of parsing the
// session's closing prose. Only paths, ids, counts and record metadata are reported; never file contents,
// credentials or environment values.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
import { redactSecrets } from './sandbox/redact.mjs';

export const SESSION_DIR = 'kpis/data/raw/sessions/';

export const ledgerPath = (companyId) => `company-profile/${companyId}/soc/main.jsonl`;

const inside = (dir, path) => {
  const rel = relative(resolve(dir), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

// Workspace files git reports as changed or untracked, each with a signature (status, size, mtime) so a file that
// was already dirty before the run and changed again is still noticed. Returns Map<path, signature> or null when
// the workspace is not a git checkout.
export function workspaceSnapshot(root = '.') {
  const r = spawnSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) return null;
  const snap = new Map();
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i += 1; // the next field is the original path of a rename or copy
    let sig = code;
    try { const st = statSync(join(root, path)); sig += `:${st.size}:${st.mtimeMs}`; } catch { sig += ':deleted'; }
    snap.set(path, sig);
  }
  return snap;
}

// Paths whose state differs between two snapshots (new, changed again, deleted, or reverted to clean), split into
// workspace files and the session KPI files every run writes under kpis/data/raw/sessions/.
export function changedFiles(before, after) {
  if (!before || !after) return { files: null, sessionFiles: null };
  const paths = new Set();
  for (const [p, sig] of after) if (before.get(p) !== sig) paths.add(p);
  for (const p of before.keys()) if (!after.has(p)) paths.add(p);
  const sorted = [...paths].sort();
  return { files: sorted.filter((p) => !p.startsWith(SESSION_DIR)), sessionFiles: sorted.filter((p) => p.startsWith(SESSION_DIR)) };
}

// The ledger is append-only, so the run's records are the bytes after the pre-run size.
export const ledgerOffset = (file) => (existsSync(file) ? statSync(file).size : 0);

export function readAppended(file, offset) {
  if (!existsSync(file)) return '';
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return '';
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

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
      const pick = (k) => (rec[k] === undefined ? undefined : rec[k]);
      findings.push(Object.fromEntries(Object.entries({
        id: pick('id'), title: pick('title'), severity: pick('severity'), status: pick('status'), fingerprint: pick('fingerprint'),
        supersedes: pick('supersedes'), slaDueAt: pick('slaDueAt'), firstSeenAt: pick('firstSeenAt'), lastSeenAt: pick('lastSeenAt'),
      }).filter(([, v]) => v !== undefined)));
    }
  }
  return { ledger: { appended, byKind, ids, unparsable }, findings };
}

// Runs `npm run validate` and keeps its exit code and a short, redacted tail of its output.
export function runValidation(root = '.', { npm = 'npm', tailLines = 15 } = {}) {
  const r = spawnSync(npm, ['run', '-s', 'validate'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
  const lines = `${r.stdout || ''}${r.stderr || ''}`.split('\n').filter((l) => l.trim() && !l.startsWith('strict mode:'));
  const tail = redactSecrets(lines.slice(-tailLines).join('\n').slice(-3000)).text;
  return { ran: true, ok: r.status === 0, exitCode: r.status === null ? null : r.status, tail };
}

// The result file is runtime state for the caller, so it must live outside the workspace.
export function checkResultPath(path, root = '.') {
  if (!path) return null;
  const abs = resolve(root, path);
  if (inside(root, abs)) return `--result-file must be outside the workspace (${abs} is inside ${resolve(root)})`;
  if (!existsSync(dirname(abs))) return `--result-file directory ${dirname(abs)} does not exist`;
  return null;
}

export function writeResultFile(path, doc, root = '.') {
  const abs = resolve(root, path);
  const tmp = join(dirname(abs), `.${basename(abs)}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, abs);
  return abs;
}
