#!/usr/bin/env node
// Runs one read-only runtime probe command against one application environment, the only way runtime probes execute
// anything. Rules of engagement enforced before the command runs: access method and read-only flag, change freezes
// and allowed windows on a fresh clock, the per-minute rate limit, the command allow-list (verbs, secrets, prod logs,
// flags) and read-only, environment-scoped credentials resolved from the sops locator. The command runs in the
// company's runtime executor (kubernetes, docker or host); pipe stages (jq, grep, head -c) run afterwards on this
// machine with the pinned jq. Output is capped at 1 MiB and redacted before it is printed.
//   node .claude/scripts/sandbox/exec.mjs --company <c> --app <app_id> --env <env_id> [--dry-run] -- <command ...> [--pipe <stage ...>]
// Exit: 0 the command ran (its exit code is in the JSON), 2 refused by policy or usage, 3 blocked, missing access or
// no executor (record it per rules of engagement sections 4 and 8), 5 executor failure.
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkPipeline, splitStages } from '../lib/sandbox/command-policy.mjs';
import { credentialMaterial, environmentBlockers, grepStage, headStage, rateLimit, resolveLocator } from '../lib/sandbox/runtime.mjs';
import { loadExecutor, runRuntimeCommand, runtimeExecutor } from '../lib/sandbox/index.mjs';
import { ensureHostTool, loadToolchain, ToolchainError } from '../lib/toolchain.mjs';
import { ExecutorError, clip } from '../lib/sandbox/common.mjs';
import { redactSecrets } from '../lib/sandbox/redact.mjs';

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAX_OUTPUT = 1 << 20;
const TIMEOUT_SECONDS = 60;
const EXIT = { usage: 2, refused: 2, blocked: 3, 'missing-access': 3, 'no-executor': 3, 'not-configured': 3, 'invalid-config': 3 };
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function fail(code, message, extra = {}) {
  const out = { error: code, message, ...extra };
  if (['blocked', 'missing-access', 'no-executor', 'not-configured'].includes(code)) out.action = 'Do not try another way in. Record the environment as blocked or missing access (rules of engagement section 8), or write the planned command as a DRY RUN observation (section 4).';
  process.stderr.write(`${JSON.stringify(out)}\n`);
  process.exit(EXIT[code] || 5);
}

const sep = process.argv.indexOf('--');
if (sep < 0) fail('usage', 'usage: exec.mjs --company <c> --app <app_id> --env <env_id> [--dry-run] -- <command ...> [--pipe <stage ...>]');
let flags;
try {
  ({ values: flags } = parseArgs({ args: process.argv.slice(2, sep), options: { company: { type: 'string' }, app: { type: 'string' }, env: { type: 'string' }, 'dry-run': { type: 'boolean' } } }));
} catch (err) { fail('usage', err.message); }
const slug = /^[a-z0-9][a-z0-9-]{1,62}$/;
for (const k of ['company', 'app', 'env']) if (!flags[k] || !slug.test(flags[k])) fail('usage', `--${k} <slug> is required`);
const stages = splitStages(process.argv.slice(sep + 1));
const envPath = join(WORKSPACE, 'applications', flags.app, 'env', `${flags.env}.json`);
if (!existsSync(envPath)) fail('usage', `applications/${flags.app}/env/${flags.env}.json does not exist`);
const environment = JSON.parse(readFileSync(envPath, 'utf8'));
const access = environment.probeAccess || {};

const at = new Date();
const blockers = environmentBlockers(environment, at);
if (blockers.length) fail('blocked', `${flags.app}/${flags.env} is closed to probes`, { blockers });

const allowlist = JSON.parse(readFileSync(join(WORKSPACE, '.claude/skills/runtime-probe-rules-of-engagement/references/command-allowlist.json'), 'utf8'));
const verdict = checkPipeline(stages, { allowlist, method: access.method, tier: environment.tier, urls: environment.urls || [] });
if (!verdict.ok) fail('refused', verdict.reason, { command: stages[0].slice(0, 4) });

if (flags['dry-run']) {
  console.log(JSON.stringify({ dryRun: true, allowed: true, app: flags.app, env: flags.env, tier: environment.tier, method: access.method, stages, checkedAt: iso(at) }, null, 2));
  process.exit(0);
}

function rateGate(state) {
  const dir = join(process.env.HOME || homedir(), '.cache', 'maxwell', 'ratelimit');
  const file = join(dir, `${flags.app}__${flags.env}.json`);
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    const r = rateLimit(saved, { limit: access.rateLimitPerMinute, tier: environment.tier, at: Date.now() });
    if (r.ok) { writeFileSync(file, JSON.stringify(r.timestamps)); return r.cap; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(r.waitMs, 61000));
  }
  return fail('blocked', `rate limit of ${access.rateLimitPerMinute || 30} commands per minute reached for ${flags.app}/${flags.env}`);
}

async function main() {
  const config = loadExecutor(flags.company, { root: WORKSPACE });
  const executor = runtimeExecutor(config);
  const binary = stages[0][0];
  if (executor.provider !== 'host' && binary === 'ssh') fail('missing-access', 'ssh runs only on the host executor');
  let material = { env: {}, files: {} };
  if (access.credentialKey) {
    const got = spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/creds/sops.mjs'), 'get', flags.app, access.credentialKey], { cwd: WORKSPACE, encoding: 'utf8' });
    if (got.status !== 0) fail('missing-access', `the credential locator ${access.credentialKey} could not be read: ${clip(got.stderr, 300)}`);
    const value = resolveLocator(JSON.parse(got.stdout), { envId: flags.env, workspace: WORKSPACE });
    material = credentialMaterial({ method: access.method, binary, value, executor: executor.provider, readFile: (p) => readFileSync(p, 'utf8') });
  }
  rateGate();
  const manifest = loadToolchain();
  const started = new Date();
  const r = await runRuntimeCommand(config, { manifest, argv: stages[0], env: material.env, files: material.files, timeoutSeconds: TIMEOUT_SECONDS });
  let output = r.stdout || '';
  for (const stage of stages.slice(1)) {
    if (stage[0] === 'jq') {
      const { path: jq } = await ensureHostTool(manifest, 'jq');
      const j = spawnSync(jq, stage.slice(1), { input: output, encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20 });
      if (j.status !== 0) fail('refused', `jq failed: ${clip(j.stderr, 300)}`);
      output = j.stdout;
    } else if (stage[0] === 'grep') output = grepStage(stage, output);
    else if (stage[0] === 'head') output = headStage(stage, output);
  }
  const truncated = Buffer.byteLength(output) > MAX_OUTPUT;
  if (truncated) output = Buffer.from(output).subarray(0, MAX_OUTPUT).toString('utf8');
  const redacted = redactSecrets(output);
  console.log(JSON.stringify({
    app: flags.app, env: flags.env, tier: environment.tier, command: stages.map((s) => s.join(' ')).join(' | '),
    collectedAt: iso(started), exitCode: r.exitCode, timedOut: r.timedOut, stdout: redacted.text,
    stdoutSha256: createHash('sha256').update(redacted.text).digest('hex'), truncated, redactions: redacted.count,
    stderrTail: redactSecrets(clip(r.stderr, 1500)).text, executor: r.provenance,
  }, null, 2));
}

main().catch((err) => {
  if (err instanceof ExecutorError || err instanceof ToolchainError) fail(err.code, err.message);
  fail('executor', err.message);
});
