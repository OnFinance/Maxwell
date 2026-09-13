#!/usr/bin/env node
// Validates every workspace file against the schema its layout rule names.
// Exit 0 = all good, 2 = validation errors, 1 = tool error. Usage: validate-data.mjs [paths...]
import { readFileSync, readlinkSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import matter from 'gray-matter';
import { buildAjv, getValidator, formatErrors } from './lib/schemas.mjs';
import { loadLayout, matchRule, walkWorkspace } from './lib/layout.mjs';

const layout = loadLayout();
const { ajv } = buildAjv();
const problems = [];
const report = (file, msg) => problems.push(`${file}: ${msg}`);

function validateJson(file, rule, data) {
  const validate = getValidator(ajv, rule.schema);
  if (!validate(data)) report(file, `does not match ${rule.schema}\n${formatErrors(validate.errors)}`);
}

function validateJsonl(file, rule) {
  const validate = getValidator(ajv, rule.schema);
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.trim() === '') {
      if (i !== lines.length - 1) report(file, `line ${i + 1}: blank line inside JSONL`);
      return;
    }
    let obj;
    try { obj = JSON.parse(line); } catch (e) { report(file, `line ${i + 1}: invalid JSON (${e.message})`); return; }
    if (!validate(obj)) report(file, `line ${i + 1}: does not match ${rule.schema}\n${formatErrors(validate.errors)}`);
  });
}

function validateFrontmatter(file, rule) {
  const raw = readFileSync(file, 'utf8');
  if (!raw.startsWith('---\n')) { report(file, 'must start with a YAML frontmatter block on line 1'); return; }
  let parsed;
  try { parsed = matter(raw); } catch (e) { report(file, `frontmatter parse error: ${e.message}`); return; }
  validateJson(file, rule, parsed.data);
}

function validateDiff(file) {
  const text = readFileSync(file, 'utf8');
  const hasHeader = /^(diff --git |--- |\+\+\+ |# maxwell)/m.test(text);
  const hasHunk = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(text);
  if (!hasHeader || !hasHunk) report(file, 'not a unified diff (needs ---/+++ or diff --git headers and @@ hunks)');
  if (/^# maxwell-/m.test(text) === false && /soc\/versions\//.test(file)) report(file, 'soc version diff must carry "# maxwell-soc-version:" header lines');
}

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /ghp_[A-Za-z0-9]{36}/, /sk-ant-[A-Za-z0-9_-]{20,}/, /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /"(password|secret|token|apiKey|api_key|privateKey)"\s*:\s*"(?!ENC\[)[^"]{8,}"/i,
];

function validateSopsJson(file, rule) {
  let obj;
  try { obj = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { report(file, `invalid JSON (${e.message})`); return; }
  const encrypted = obj && typeof obj === 'object' && obj.sops && (obj.sops.age || obj.sops.kms || obj.sops.gcp_kms || obj.sops.azure_kv || obj.sops.pgp);
  if (!encrypted) {
    report(file, 'must be sops-encrypted at rest (missing "sops" metadata). Encrypt with: npx maxwell-creds encrypt <app_id>');
    return;
  }
  const raw = readFileSync(file, 'utf8');
  for (const p of SECRET_PATTERNS) if (p.test(raw)) report(file, `looks like a plaintext secret matched ${p}`);
  const keyFile = process.env.SOPS_AGE_KEY_FILE;
  if (keyFile && existsSync(keyFile)) {
    const res = spawnSync('sops', ['--decrypt', '--input-type', 'json', '--output-type', 'json', file], { encoding: 'utf8', env: process.env });
    if (res.status !== 0) { report(file, `sops decrypt failed: ${res.stderr.trim()}`); return; }
    try { validateJson(file, rule, JSON.parse(res.stdout)); } catch (e) { report(file, `decrypted content is not JSON (${e.message})`); }
  } else if (process.env.MAXWELL_REQUIRE_DECRYPT === '1') {
    report(file, 'SOPS_AGE_KEY_FILE not set; cannot validate decrypted content');
  }
}

function validateSymlink(file, rule) {
  const st = statSync(file, { throwIfNoEntry: false });
  let target;
  try { target = readlinkSync(file); } catch { report(file, `must be a symlink to ${rule.target}`); return; }
  if (target !== rule.target) report(file, `symlink points to ${target}, expected ${rule.target}`);
  if (!st) report(file, 'dangling symlink');
}

const explicit = process.argv.slice(2).map((p) => p.replace(/^\.\//, ''));
const entries = explicit.length ? explicit.map((relPath) => ({ relPath, isDir: false, isSymlink: false })) : walkWorkspace('.');

for (const entry of entries) {
  if (entry.isDir || entry.checkout) continue;
  const rule = matchRule(layout, entry.relPath);
  if (!rule) { report(entry.relPath, 'not a sanctioned path in .claude/schemas/layout.json'); continue; }
  try {
    switch (rule.format) {
      case 'json': validateJson(entry.relPath, rule, JSON.parse(readFileSync(entry.relPath, 'utf8'))); break;
      case 'jsonl': validateJsonl(entry.relPath, rule); break;
      case 'frontmatter': validateFrontmatter(entry.relPath, rule); break;
      case 'diff': validateDiff(entry.relPath); break;
      case 'sops-json': validateSopsJson(entry.relPath, rule); break;
      case 'symlink': validateSymlink(entry.relPath, rule); break;
      case 'empty': if (statSync(entry.relPath).size !== 0) report(entry.relPath, 'must be empty'); break;
      case 'json-schema': case 'markdown': case 'yaml': case 'javascript': case 'workflow': case 'any': break;
      default: report(entry.relPath, `unknown format ${rule.format}`);
    }
  } catch (e) {
    report(entry.relPath, `${e.message}`);
  }
}

if (problems.length) {
  console.error(`validate:data FAILED (${problems.length} problem${problems.length === 1 ? '' : 's'})`);
  for (const p of problems) console.error('- ' + p);
  process.exit(2);
}
console.log(`validate:data OK (${entries.filter((e) => !e.isDir && !e.checkout).length} files)`);
