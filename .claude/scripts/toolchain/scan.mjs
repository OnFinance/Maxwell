#!/usr/bin/env node
// Runs one pinned scanner over one application checkout in the company's configured executor
// (company-profile/<company_id>/sdlc/executor.json) and writes its result to a sanctioned session export.
//   node .claude/scripts/toolchain/scan.mjs --company <c> --app <app_id> --repo <repo_id> --tool <name>
//        --out kpis/data/raw/sessions/<session>/<name>.export.json [--from-stdout] -- <scanner args with {src} and {result}>
// {src} is the checkout (read-only) and {result} the one file the scanner writes; with --from-stdout the scanner's
// standard output is the result instead. The version the scanner prints must match toolchain.json before anything is
// kept. Secret-shaped strings are redacted, SARIF runs are stamped with the pin, and a JSON summary is printed.
// Exit: 0 the scanner ran (its own exit code is in the summary), 2 usage or policy, 3 no executor configured,
// 4 pin or version mismatch, 5 executor failure.
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTool, loadToolchain, ToolchainError } from '../lib/toolchain.mjs';
import { loadExecutor, runStaticTool, staticExecutor } from '../lib/sandbox/index.mjs';
import { applyCredentials } from '../lib/sandbox/credentials.mjs';
import { checkToolArgs } from '../lib/sandbox/scan-policy.mjs';
import { ExecutorError, clip } from '../lib/sandbox/common.mjs';
import { loadLayout, matchRule } from '../lib/layout.mjs';
import { redactSecrets } from '../lib/sandbox/redact.mjs';

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXIT = { usage: 2, policy: 2, 'no-executor': 3, 'not-configured': 3, 'invalid-config': 3, 'version-mismatch': 4, 'checksum-mismatch': 4, 'lock-mismatch': 4, 'sdk-integrity': 4, 'not-pinned': 2 };

function fail(code, message, extra = {}) {
  const out = { error: code, message, ...extra };
  if (code === 'no-executor' || code === 'not-configured') out.action = 'Interactive session: ask the user to run /connect-sandbox. Headless run: do not run the scanner another way; review the checkout manually and record "scanner not run: no executor configured" in skipped.';
  process.stderr.write(JSON.stringify(out) + '\n');
  process.exit(EXIT[code] || 5);
}

function stripTrufflehogRaw(text) {
  return text.split('\n').map((line) => {
    if (!line.trim().startsWith('{')) return line;
    try {
      const o = JSON.parse(line);
      for (const k of ['Raw', 'RawV2']) if (k in o) o[k] = '[REDACTED]';
      return JSON.stringify(o);
    } catch { return line; }
  }).join('\n');
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: { company: { type: 'string' }, app: { type: 'string' }, repo: { type: 'string' }, tool: { type: 'string' }, out: { type: 'string' }, 'from-stdout': { type: 'boolean' } },
  });
} catch (err) { fail('usage', err.message); }
const { values: flags, positionals: argv } = parsed;
for (const k of ['company', 'app', 'repo', 'tool', 'out']) if (!flags[k]) fail('usage', `--${k} is required`);
const slug = /^[a-z0-9][a-z0-9-]{1,62}$/;
for (const k of ['company', 'app', 'repo']) if (!slug.test(flags[k])) fail('usage', `--${k} must be a slug`);

const outRel = relative(WORKSPACE, resolve(WORKSPACE, flags.out));
if (!/^kpis\/data\/raw\/sessions\/[^/]+\/[^/]+\.export\.json$/.test(outRel) || !matchRule(loadLayout(join(WORKSPACE, '.claude/schemas/layout.json')), outRel)) {
  fail('usage', `--out must be a sanctioned session export, kpis/data/raw/sessions/<session>/<name>.export.json; got ${flags.out}`);
}
const checkout = join(WORKSPACE, 'applications', flags.app, 'repos', flags.repo);
if (!existsSync(checkout) || !statSync(checkout).isDirectory()) fail('usage', `no checkout at applications/${flags.app}/repos/${flags.repo}; run refresh-apps first`);
const repoDir = realpathSync(checkout);
if (relative(join(WORKSPACE, 'applications'), repoDir).startsWith('..')) fail('policy', 'the checkout resolves outside applications/');

const policy = checkToolArgs(flags.tool, argv);
if (!policy.ok) fail('policy', policy.reason);
if (!flags['from-stdout'] && !argv.some((a) => a.includes('{result}'))) fail('usage', 'reference {result} in the scanner arguments, or pass --from-stdout');

async function main() {
  const manifest = loadToolchain();
  const tool = getTool(manifest, flags.tool);
  if (tool.category !== 'scanner') fail('policy', `${tool.name} is a ${tool.category}, not a scanner`);
  const config = loadExecutor(flags.company, { root: WORKSPACE });
  const executor = staticExecutor(config);
  applyCredentials(executor.provider);
  const staging = mkdtempSync(join(tmpdir(), 'maxwell-result-'));
  try {
    const resultPath = join(staging, 'result');
    const r = await runStaticTool(config, { manifest, tool, argv, repoDir, resultPath });
    let body = flags['from-stdout'] ? r.stdout : existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : null;
    if (body === null) fail('executor', `${tool.name} exited ${r.exitCode} without writing {result}`, { stderr: redactSecrets(clip(r.stderr, 2000)).text, provenance: r.provenance });
    if (tool.name === 'trufflehog') body = stripTrufflehogRaw(body);
    const redacted = redactSecrets(body);
    const pin = { tool: tool.name, version: tool.version, ...r.provenance };
    let doc; let format = 'text';
    try { doc = JSON.parse(redacted.text); format = doc && Array.isArray(doc.runs) && doc.version ? 'sarif' : 'json'; } catch { doc = null; }
    if (format === 'sarif') {
      for (const run of doc.runs) {
        run.tool = run.tool || { driver: { name: tool.name } };
        run.tool.driver = run.tool.driver || { name: tool.name };
        if (!run.tool.driver.version) run.tool.driver.version = tool.version;
        run.properties = { ...(run.properties || {}), 'maxwell:toolchain': pin };
      }
    } else {
      doc = { 'maxwell:toolchain': pin, format, exitCode: r.exitCode, content: format === 'json' ? doc : redacted.text };
    }
    const outPath = join(WORKSPACE, outRel);
    mkdirSync(dirname(outPath), { recursive: true });
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    writeFileSync(outPath, text);
    const results = format === 'sarif' ? doc.runs.reduce((n, run) => n + ((run.results || []).length), 0) : undefined;
    process.stdout.write(`${JSON.stringify({
      tool: tool.name, version: tool.version, exitCode: r.exitCode, timedOut: r.timedOut, out: outRel,
      sha256: createHash('sha256').update(text).digest('hex'), format, ...(results !== undefined ? { sarifResults: results } : {}),
      redactions: redacted.count, provenance: r.provenance, stderrTail: redactSecrets(clip(r.stderr, 1500)).text,
    }, null, 2)}\n`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main().catch((err) => {
  if (err instanceof ExecutorError || err instanceof ToolchainError) fail(err.code, err.message);
  fail('executor', err.message);
});
