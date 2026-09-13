// Shared helpers for Maxwell hooks (Claude Code hook processes and the OpenCode plugin call the same code).
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

export function readStdinJson() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function workspaceRoot(input) {
  return process.env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd();
}

// Returns the workspace-relative POSIX path, or null when the path escapes the workspace.
export function toWorkspacePath(root, filePath) {
  if (!filePath) return null;
  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  const rel = relative(root, abs).split('\\').join('/');
  if (rel.startsWith('..') || rel === '') return null;
  return rel;
}

export const SECRET_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}/, 'GitHub token'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/AIza[0-9A-Za-z_-]{35}/, 'Google API key'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/"(password|passwd|secret|client_secret|access_token|refresh_token|api_key|apiKey|privateKey|private_key)"\s*:\s*"(?!ENC\[|\$\{|env:|vault:|op:\/\/)[^"]{8,}"/i, 'secret-valued JSON key'],
];

export function findSecret(text) {
  if (!text) return null;
  for (const [re, label] of SECRET_PATTERNS) if (re.test(text)) return label;
  return null;
}

export function block(message) {
  process.stderr.write(`[maxwell] BLOCKED: ${message}\n`);
  process.exit(2);
}

export function runValidator(root, relPath) {
  const res = spawnSync(process.execPath, [resolve(root, '.claude/scripts/validate-data.mjs'), relPath], { cwd: root, encoding: 'utf8', env: process.env });
  return { ok: res.status === 0, output: (res.stdout || '') + (res.stderr || '') };
}

export function readJsonIfExists(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

// Crockford base32 ULID from a timestamp + crypto randomness.
export function ulid(now = Date.now()) {
  const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = now; let time = '';
  for (let i = 0; i < 10; i += 1) { time = ENC[t % 32] + time; t = Math.floor(t / 32); }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let rand = '';
  for (let i = 0; i < 16; i += 1) rand += ENC[bytes[i] % 32];
  return time + rand;
}

// Parses "/<workflow> <companyId> [--flag ...]" from a user prompt.
export function parseWorkflowInvocation(prompt, workflows) {
  if (typeof prompt !== 'string') return null;
  const m = /^\s*\/([a-z0-9-]+)\s*(.*)$/s.exec(prompt);
  if (!m || !workflows.includes(m[1])) return null;
  const rest = m[2].trim().split(/\s+/).filter(Boolean);
  const companyId = rest.find((t) => /^[a-z0-9][a-z0-9-]{1,62}$/.test(t) && !t.startsWith('-')) || null;
  const dryRun = rest.includes('--dry-run') || rest.includes('dryRun=true');
  const appIds = rest.filter((t) => t.startsWith('--app=')).map((t) => t.slice(6));
  const envIds = rest.filter((t) => t.startsWith('--env=')).map((t) => t.slice(6));
  return { workflow: m[1], companyId, args: { appIds, envIds, dryRun } };
}
