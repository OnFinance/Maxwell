#!/usr/bin/env node
// Connects a company to the executors that run pinned scanners (static) and read-only runtime probe commands (runtime).
// /connect-sandbox asks the user the questions and calls this script; nothing here is interactive.
//   options [--company <c>]                                  what each provider needs, as JSON
//   status  --company <c>                                    current choice, credential names present, last checks
//   set     --company <c> --static <provider> --runtime <provider> [--region <r>] [--network none|package-registries]
//           [--settings '<JSON for providers.<provider>>'] [--runtime-settings '<JSON>'] [--accept-residency] [--session <id>]
//           credentials, when the provider needs them, as a JSON object on stdin (never as arguments)
//   test    --company <c> [--scope static|runtime|both]      runs a pinned tool through each executor and records the result
// Exit: 0 ok, 1 a check failed, 2 usage, 3 not configured.
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildAjv, getValidator, formatErrors } from '../lib/schemas.mjs';
import { ensureHostTool, getTool, imageRef, loadToolchain } from '../lib/toolchain.mjs';
import { BACKENDS, EXECUTOR_SCHEMA, executorPath, loadExecutor, runtimeExecutor, staticExecutor } from '../lib/sandbox/index.mjs';
import { PROVIDER_CREDENTIALS, applyCredentials, writeCredentials } from '../lib/sandbox/credentials.mjs';
import { ExecutorError, HOSTED, RUNTIME_PROVIDERS, limitsOf } from '../lib/sandbox/common.mjs';

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const INDIA_REGIONS = { modal: ['ap-south'], vercel: ['bom1'] };

export const OPTIONS = {
  static: [
    { provider: 'kubernetes', label: 'Kubernetes (your cluster)', hosting: 'self-hosted', isolation: 'one non-root pod per scan, read-only checkout, service account token not mounted; needs a default-deny egress NetworkPolicy in the namespace', residency: 'wherever your cluster runs', settings: { required: ['kubeconfigEnv', 'namespace'], optional: ['context', 'serviceAccount', 'imagePullSecret', 'nodeSelector'] }, credentials: [], hostNeeds: 'the environment variable named by kubeconfigEnv holds the path to the executor cluster kubeconfig; kubectl is installed from the pinned toolchain' },
    { provider: 'docker', label: 'Docker or Podman (this machine)', hosting: 'self-hosted', isolation: 'container per scan with no network, read-only root, all capabilities dropped', residency: 'this machine', settings: { required: [], optional: ['engine'] }, credentials: [], hostNeeds: 'docker or podman on PATH' },
    { provider: 'e2b', label: 'E2B', hosting: 'hosted', isolation: 'Firecracker microVM per scan, internet blocked', residency: 'US by default, EU on request; BYOC and self-hosting available', indiaRegion: null, settings: { required: [], optional: ['domain'] }, credentials: PROVIDER_CREDENTIALS.e2b, notes: 'Python scanners (semgrep, checkov, sqlfluff, bandit) install inside the sandbox, so they need network package-registries' },
    { provider: 'daytona', label: 'Daytona', hosting: 'hosted', isolation: 'sandbox per scan from the digest-pinned base image, all network blocked', residency: 'US and EU; BYOC custom regions', indiaRegion: null, settings: { required: [], optional: ['target', 'apiUrl'] }, credentials: PROVIDER_CREDENTIALS.daytona },
    { provider: 'modal', label: 'Modal', hosting: 'hosted', isolation: 'sandbox per scan from the digest-pinned base image, network blocked', residency: 'region selectable; ap-south is Mumbai', indiaRegion: 'ap-south', settings: { required: [], optional: ['environment', 'appName'] }, credentials: PROVIDER_CREDENTIALS.modal },
    { provider: 'vercel', label: 'Vercel Sandbox', hosting: 'hosted', isolation: 'microVM per scan, deny-all network policy', residency: 'region selectable; bom1 is Mumbai', indiaRegion: 'bom1', settings: { required: ['teamId', 'projectId'], optional: [] }, credentials: PROVIDER_CREDENTIALS.vercel, notes: 'Python scanners need network package-registries' },
    { provider: 'host', label: 'This machine, no isolation', hosting: 'self-hosted', isolation: 'none: pinned, checksum-verified binaries run directly on the host', residency: 'this machine', settings: { required: [], optional: [] }, credentials: [] },
    { provider: 'none', label: 'No scanners', hosting: 'none', isolation: 'scanners never run; static probes review checkouts manually', settings: { required: [], optional: [] }, credentials: [] },
  ],
  runtime: [
    { provider: 'kubernetes', label: 'Kubernetes (your cluster)', isolation: 'one pod per command with the CLI image pinned by digest; credentials in a Secret deleted with the pod' },
    { provider: 'docker', label: 'Docker or Podman (this machine)', isolation: 'container per command with the CLI image pinned by digest; credential files mounted read-only' },
    { provider: 'host', label: 'This machine, no isolation', isolation: 'none: kubectl and jq are pinned, other CLIs are the ones installed on the host (their version is recorded)' },
    { provider: 'none', label: 'Plan only', isolation: 'no live commands; runtime probes write the plan as with --dry-run' },
  ],
  runtimeNote: 'Hosted sandboxes are not offered for runtime probes: those commands carry the target environment credentials, which stay on infrastructure you run.',
};

function fail(code, message, extra = {}) {
  process.stderr.write(`${JSON.stringify({ error: code, message, ...extra })}\n`);
  process.exit({ usage: 2, 'not-configured': 3 }[code] || 1);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      company: { type: 'string' }, static: { type: 'string' }, runtime: { type: 'string' }, region: { type: 'string' }, network: { type: 'string' },
      settings: { type: 'string' }, 'runtime-settings': { type: 'string' }, 'accept-residency': { type: 'boolean' }, session: { type: 'string' }, scope: { type: 'string' },
    },
  });
} catch (err) { fail('usage', err.message); }
const { values: flags, positionals: [cmd] } = parsed;
const needCompany = () => {
  if (!flags.company || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(flags.company)) fail('usage', '--company <company_id> is required');
  if (!existsSync(join(WORKSPACE, 'company-profile', flags.company, 'details.json'))) fail('usage', `company-profile/${flags.company}/details.json does not exist`);
};

function writeConfig(config) {
  const check = getValidator(buildAjv().ajv, EXECUTOR_SCHEMA);
  if (!check(config)) fail('usage', `the executor configuration would not match its schema:\n${formatErrors(check.errors)}`);
  const path = executorPath(flags.company, WORKSPACE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

const parseJson = (text, what) => {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch (err) { return fail('usage', `${what} must be a JSON object: ${err.message}`); }
};

async function smokeStatic(config, manifest) {
  const ex = staticExecutor(config);
  const creds = applyCredentials(ex.provider);
  if (creds.missing.length) throw new ExecutorError('not-configured', `missing credentials for ${ex.provider}: ${creds.missing.join(', ')}`);
  const tool = getTool(manifest, 'gitleaks');
  const repoDir = mkdtempSync(join(tmpdir(), 'maxwell-smoke-'));
  writeFileSync(join(repoDir, 'README.md'), 'Maxwell executor connection check\n');
  try {
    const r = await BACKENDS[ex.provider].runTool({ manifest, tool, argv: tool.versionCheck.args, repoDir, resultPath: join(repoDir, 'result'), network: ex.network, limits: { ...ex.limits, timeoutSeconds: 300 }, region: ex.region, providerConfig: ex.providerConfig });
    if (r.exitCode !== 0) throw new ExecutorError('check-failed', `gitleaks exited ${r.exitCode} in ${ex.provider}`);
    const messages = [`gitleaks ${tool.version} ran in ${ex.provider} and printed its pinned version (${r.provenance.versionOutput || tool.version})`];
    if (ex.provider === 'kubernetes') {
      const { path: kubectl } = await ensureHostTool(manifest, 'kubectl');
      const cfg = ex.providerConfig;
      const res = spawnSync(kubectl, ['--kubeconfig', process.env[cfg.kubeconfigEnv], ...(cfg.context ? ['--context', cfg.context] : []), '-n', cfg.namespace, 'get', 'networkpolicy', '-o', 'json'], { encoding: 'utf8' });
      const items = res.status === 0 ? JSON.parse(res.stdout).items || [] : [];
      const denyAll = items.some((p) => p.spec && p.spec.podSelector && !Object.keys(p.spec.podSelector.matchLabels || {}).length && !(p.spec.podSelector.matchExpressions || []).length && (p.spec.policyTypes || []).includes('Egress') && !(p.spec.egress || []).length);
      if (!denyAll) throw new ExecutorError('check-failed', `namespace ${cfg.namespace} has no default-deny egress NetworkPolicy, so scanner pods could reach the network`);
      messages.push(`default-deny egress NetworkPolicy present in ${cfg.namespace}`);
    }
    return { scope: 'static', provider: ex.provider, result: 'passed', tool: 'gitleaks', toolVersion: tool.version, message: messages.join('; ').slice(0, 500) };
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
}

async function smokeRuntime(config, manifest) {
  const ex = runtimeExecutor(config);
  const tool = getTool(manifest, 'kubectl');
  const r = await BACKENDS[ex.provider].runCommand({ manifest, argv: ['kubectl', 'version', '--client'], env: {}, files: {}, timeoutSeconds: 120, providerConfig: ex.providerConfig });
  const out = `${r.stdout}${r.stderr}`;
  if (r.exitCode !== 0 || !out.includes(tool.version)) throw new ExecutorError('check-failed', `kubectl version --client in ${ex.provider} printed "${out.split('\n')[0].slice(0, 120)}", expected ${tool.version}`);
  return { scope: 'runtime', provider: ex.provider, result: 'passed', tool: 'kubectl', toolVersion: tool.version, message: `pinned kubectl ${tool.version} ran through ${ex.provider}${ex.provider === 'host' ? '' : ` (${imageRef(tool.image)})`}` };
}

async function main() {
  switch (cmd) {
    case 'options': {
      let residency = null;
      if (flags.company) {
        needCompany();
        residency = JSON.parse(readFileSync(join(WORKSPACE, 'company-profile', flags.company, 'details.json'), 'utf8')).dataResidency || null;
      }
      console.log(JSON.stringify({ ...OPTIONS, companyDataResidency: residency }, null, 2));
      return;
    }
    case 'status': {
      needCompany();
      const config = loadExecutor(flags.company, { root: WORKSPACE });
      if (!config) { console.log(JSON.stringify({ configured: false, action: 'run /connect-sandbox' }, null, 2)); return; }
      const creds = Object.fromEntries([...new Set([config.static.provider, config.runtime.provider])].filter((p) => PROVIDER_CREDENTIALS[p]).map((p) => [p, applyCredentials(p, { ...process.env })]));
      console.log(JSON.stringify({ configured: true, static: config.static, runtime: config.runtime, providers: config.providers || {}, credentials: Object.fromEntries(Object.entries(creds).map(([p, c]) => [p, { present: c.present, missing: c.missing }])), lastChecks: (config.verification || []).slice(-4) }, null, 2));
      return;
    }
    case 'set': {
      needCompany();
      const staticProvider = flags.static; const runtimeProvider = flags.runtime;
      if (!OPTIONS.static.some((o) => o.provider === staticProvider)) fail('usage', `--static must be one of ${OPTIONS.static.map((o) => o.provider).join(', ')}`);
      if (![...RUNTIME_PROVIDERS, 'none'].includes(runtimeProvider)) fail('usage', `--runtime must be one of ${[...RUNTIME_PROVIDERS, 'none'].join(', ')}; hosted sandboxes never receive target credentials`);
      if (flags.network && !['none', 'package-registries'].includes(flags.network)) fail('usage', '--network must be none or package-registries');
      const details = JSON.parse(readFileSync(join(WORKSPACE, 'company-profile', flags.company, 'details.json'), 'utf8'));
      const indiaOnly = Array.isArray(details.dataResidency) && details.dataResidency.length > 0 && details.dataResidency.every((c) => c === 'IN');
      if (indiaOnly && HOSTED.includes(staticProvider) && !(INDIA_REGIONS[staticProvider] || []).includes(flags.region) && !flags['accept-residency']) {
        const india = INDIA_REGIONS[staticProvider];
        fail('usage', `${flags.company} restricts data residency to India, and ${staticProvider}${flags.region ? ` region ${flags.region}` : ''} is not an Indian region. ${india ? `Use --region ${india[0]}` : `${staticProvider} documents no Indian region; use a BYOC deployment in India`}, or pass --accept-residency after the user explicitly accepts that checkouts are scanned outside India.`);
      }
      const existing = loadExecutor(flags.company, { root: WORKSPACE }) || {};
      const providers = { ...(existing.providers || {}) };
      if (flags.settings) providers[staticProvider] = { ...(providers[staticProvider] || {}), ...parseJson(flags.settings, '--settings') };
      if (flags['runtime-settings']) providers[runtimeProvider] = { ...(providers[runtimeProvider] || {}), ...parseJson(flags['runtime-settings'], '--runtime-settings') };
      for (const p of Object.keys(providers)) if (![staticProvider, runtimeProvider].includes(p)) delete providers[p];
      const config = {
        schemaVersion: '1', kind: 'maxwell.company.executor', companyId: flags.company,
        static: { provider: staticProvider, ...(flags.region ? { region: flags.region } : {}), ...(HOSTED.includes(staticProvider) || ['docker', 'kubernetes'].includes(staticProvider) ? { network: flags.network || 'none' } : {}), ...(existing.static && existing.static.provider === staticProvider ? Object.fromEntries(Object.entries(limitsOf(existing.static)).filter(([k]) => k in existing.static)) : {}) },
        runtime: { provider: runtimeProvider },
        ...(Object.keys(providers).length ? { providers } : {}),
        ...(existing.verification ? { verification: existing.verification } : {}),
        provenance: { harness: process.env.MAXWELL_HARNESS || 'claude-code', generatedAt: now(), ...(flags.session ? { sessionId: flags.session } : {}), workflow: 'manual', agent: 'connect-sandbox' },
      };
      let credentialNames = [];
      if (!process.stdin.isTTY) {
        const raw = readFileSync(0, 'utf8').trim();
        if (raw) {
          const creds = parseJson(raw, 'stdin');
          credentialNames = Object.keys(creds);
          writeCredentials(staticProvider, creds);
        }
      }
      const path = writeConfig(config);
      const missing = applyCredentials(staticProvider).missing;
      console.log(JSON.stringify({ written: path.replace(`${WORKSPACE}/`, ''), static: config.static, runtime: config.runtime, credentialsStored: credentialNames, credentialsMissing: missing, next: missing.length ? `provide ${missing.join(', ')}, then run test` : `node .claude/scripts/sandbox/connect.mjs test --company ${flags.company}` }, null, 2));
      return;
    }
    case 'test': {
      needCompany();
      const config = loadExecutor(flags.company, { root: WORKSPACE });
      if (!config) fail('not-configured', 'no executor configured; run /connect-sandbox');
      const manifest = loadToolchain();
      const scope = flags.scope || 'both';
      const checks = [];
      for (const [name, fn, provider] of [['static', smokeStatic, config.static.provider], ['runtime', smokeRuntime, config.runtime.provider]]) {
        if (scope !== 'both' && scope !== name) continue;
        if (provider === 'none') { checks.push({ scope: name, provider, skipped: true }); continue; }
        try {
          checks.push({ at: now(), ...(await fn(config, manifest)) });
        } catch (err) {
          checks.push({ at: now(), scope: name, provider, result: 'failed', message: String(err.message).slice(0, 500) });
        }
      }
      const recorded = checks.filter((c) => !c.skipped);
      if (recorded.length) writeConfig({ ...config, verification: [...(config.verification || []), ...recorded].slice(-20), provenance: { ...config.provenance, generatedAt: now() } });
      console.log(JSON.stringify({ checks }, null, 2));
      process.exit(recorded.some((c) => c.result === 'failed') ? 1 : 0);
    }
    default:
      fail('usage', 'usage: connect.mjs options|status|set|test --company <company_id> ...');
  }
}

main().catch((err) => fail(err.code || 'error', err.message));
