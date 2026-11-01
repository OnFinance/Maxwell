#!/usr/bin/env node
// Verifies every CloudFormation template in one application checkout with AWS's own tooling and writes one SARIF 2.1.0
// export the probe's findings cite (tool, rule id, file, line):
//   1. cfn-lint (AWS's linter: schema, intrinsic functions, IAM actions, best practice)
//   2. cfn-guard with AWS's Guard rule sets (aws-guard-rules-registry: the registry's union, RBI MD-ITF, CIS level 1)
//   3. a local AWS emulator (moto, or LocalStack where Docker and a token allow it): each template created as a stack,
//      its events and resources read, the security posture of what was created read back (public buckets and ACLs,
//      unencrypted buckets, volumes and queues, wildcard IAM policies, security groups open to 0.0.0.0/0), the stack
//      deleted. A resource the emulator does not model is "not verified", never passed.
//   4. optionally the company's own AWS account, read-only (its AWS read-only access key): validate-template and, for a
//      stack named in the application's environment (iac[].stackName), describe-stacks and drift detection.
// Nothing changes the checkout, and nothing but read-only calls ever reaches AWS (lib/cfn/aws.mjs): create-stack and
// delete-stack go only to the emulator on loopback.
//
//   node .claude/scripts/toolchain/cfn-verify.mjs --company <c> --app <app_id> --repo <repo_id> \
//        --out kpis/data/raw/sessions/<session>/<workflow>.<app_id>.<repo_id>.cfn.export.json [--no-emulator]
//
// Where the tools come from: a hosted run (MAXWELL_PLATFORM_TOOLS=1) gets them from the platform's pinned run tools,
// first on PATH, with AWS's rule sets under RUN_TOOLS_DATA; each version is checked here against the toolchain pins.
// Elsewhere it exits 3 and changes nothing: run cfn-lint through scan.mjs with your executor, as before.
// Exit: 0 it ran (the export says what ran and what did not), 2 usage, 3 no platform tools, 4 a pin mismatch.
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLayout, matchRule } from '../lib/layout.mjs';
import { getTool, loadToolchain, sha256File } from '../lib/toolchain.mjs';
import { redactSecrets } from '../lib/sandbox/redact.mjs';
import { findTemplates, readTemplate, withoutTags } from '../lib/cfn/templates.mjs';
import { startEmulator, verifyInEmulator } from '../lib/cfn/emulator.mjs';
import { liveChecks, liveContext, liveCredential } from '../lib/cfn/live.mjs';
import { toSarif } from '../lib/cfn/sarif.mjs';

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PINS = JSON.parse(readFileSync(join(WORKSPACE, '.claude/skills/cfn-verification/references/pins.json'), 'utf8'));
const EXIT = { usage: 2, 'no-platform-tools': 3, 'pin-mismatch': 4 };

function fail(code, message, extra = {}) {
  const out = { error: code, message, ...extra };
  if (code === 'no-platform-tools') out.action = 'Not a hosted run with the platform\'s tools: review templates manually (or run cfn-lint through scan.mjs with your executor) and record "cfn-verify not run: no platform tools" in skipped.';
  process.stderr.write(`${JSON.stringify(out)}\n`);
  process.exit(EXIT[code] || 5);
}

let parsed;
try {
  parsed = parseArgs({ options: { company: { type: 'string' }, app: { type: 'string' }, repo: { type: 'string' }, out: { type: 'string' }, 'no-emulator': { type: 'boolean' } } });
} catch (err) { fail('usage', err.message); }
const flags = parsed.values;
for (const k of ['company', 'app', 'repo', 'out']) if (!flags[k]) fail('usage', `--${k} is required`);
const slug = /^[a-z0-9][a-z0-9-]{1,62}$/;
for (const k of ['company', 'app', 'repo']) if (!slug.test(flags[k])) fail('usage', `--${k} must be a slug`);
const outRel = relative(WORKSPACE, resolve(WORKSPACE, flags.out));
if (!/^kpis\/data\/raw\/sessions\/[^/]+\/[^/]+\.export\.json$/.test(outRel) || !matchRule(loadLayout(join(WORKSPACE, '.claude/schemas/layout.json')), outRel))
  fail('usage', `--out must be a sanctioned session export, kpis/data/raw/sessions/<session>/<name>.export.json; got ${flags.out}`);
const checkoutPath = join(WORKSPACE, 'applications', flags.app, 'repos', flags.repo);
if (!existsSync(checkoutPath) || !statSync(checkoutPath).isDirectory()) fail('usage', `no checkout at applications/${flags.app}/repos/${flags.repo}; run refresh-apps first`);
const checkout = realpathSync(checkoutPath);
if (relative(join(WORKSPACE, 'applications'), checkout).startsWith('..')) fail('usage', 'the checkout resolves outside applications/');
if (process.env.MAXWELL_PLATFORM_TOOLS !== '1') fail('no-platform-tools', 'MAXWELL_PLATFORM_TOOLS is not set: cfn-verify runs with the platform\'s pinned run tools only');

/** A program on PATH (absolute, real path), or null. */
const which = (name) => {
  for (const d of String(process.env.PATH || '').split(delimiter)) {
    if (!d) continue;
    const p = join(d, name);
    try { if (statSync(p).isFile()) return realpathSync(p); } catch { /* not here */ }
  }
  return null;
};
const versionLine = (bin, args) => { const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 60000, env: { PATH: process.env.PATH, HOME: tmpdir(), LANG: 'C.UTF-8' } }); return `${r.stdout || ''}${r.stderr || ''}`.trim().split('\n')[0] || ''; };

const toolchain = loadToolchain();
const tools = {};
const skipped = [];
for (const name of ['cfn-lint', 'cfn-guard']) {
  const pin = getTool(toolchain, name);
  const bin = which(name);
  if (!bin) { skipped.push({ step: name, reason: `${name} is not among this run's tools` }); continue; }
  const line = versionLine(bin, pin.versionCheck.args);
  if (!line.includes(pin.versionCheck.expect)) fail('pin-mismatch', `${name} printed "${line.slice(0, 120)}", the toolchain pins ${pin.version}`);
  tools[name] = { bin, version: pin.version, versionLine: line };
}
// AWS's rule sets: the platform's data directory, each file checked against its pin.
const rulesDir = process.env.RUN_TOOLS_DATA ? join(process.env.RUN_TOOLS_DATA, 'aws-guard-rules') : null;
const ruleSets = [];
if (tools['cfn-guard']) {
  if (!rulesDir || !existsSync(rulesDir)) skipped.push({ step: 'cfn-guard', reason: 'AWS\'s Guard rule sets are not among this run\'s tools (RUN_TOOLS_DATA/aws-guard-rules)' });
  else for (const [file, sha] of Object.entries(PINS.guardRules.run)) {
    const p = join(rulesDir, file);
    if (!existsSync(p)) { skipped.push({ step: 'cfn-guard', reason: `rule set ${file} is missing` }); continue; }
    if (sha256File(p) !== sha) fail('pin-mismatch', `the Guard rule set ${file} is not the pinned one (aws-guard-rules-registry ${PINS.guardRules.version})`);
    ruleSets.push({ name: file.replace(/\.guard$/, ''), path: p, sha256: sha });
  }
}
if (!tools['cfn-lint'] && !ruleSets.length) fail('no-platform-tools', 'neither cfn-lint nor cfn-guard with its rule sets is available to this run');
const awsBin = which('aws');
const awsVersion = awsBin ? versionLine(awsBin, ['--version']) : null;
const motoBin = which('moto_server');
// The platform installs each tool under <tool>/<version>/: moto's version is its install path's (it prints none).
const motoOk = motoBin && motoBin.split('/').includes(PINS.moto.version) && motoBin.includes('/moto/');

const tmp = mkdtempSync(join(tmpdir(), 'maxwell-cfn-'));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const relUri = (u) => {
  const s = String(u || '').replace(/^file:\/\//, '');
  const abs = s.startsWith('/') ? s : `/${s}`;
  const r = relative(checkout, abs);
  return r.startsWith('..') ? s : r;
};

async function main() {
  const { templates, skipped: notScanned } = findTemplates(checkout);
  for (const s of notScanned) skipped.push({ step: 'discovery', ...s });
  const report = { tool: 'cfn-verify', company: flags.company, app: flags.app, repo: flags.repo, templates: [], emulator: null, liveAws: null, skipped };
  const lint = [], guard = [], emulated = [], live = [];
  // Stack names for templates, from the application's environment files (read-only references).
  const envDir = join(WORKSPACE, 'applications', flags.app, 'env');
  const stacks = new Map(); let envRegion = null;
  if (existsSync(envDir)) for (const f of readdirSync(envDir).filter((x) => x.endsWith('.json'))) {
    try {
      const e = JSON.parse(readFileSync(join(envDir, f), 'utf8'));
      envRegion = envRegion || (e.hosting && e.hosting.region) || null;
      for (const r of e.iac || []) if (r.tool === 'cloudformation' && r.repoId === flags.repo && r.stackName) stacks.set(r.path, r.stackName);
    } catch { /* an unreadable environment file names nothing */ }
  }
  const stackFor = (rel) => stacks.get(rel) || stacks.get(dirname(rel)) || null;

  // 1-2. cfn-lint and cfn-guard, each template, offline.
  for (const rel of templates) {
    const abs = join(checkout, rel);
    const tpl = readTemplate(readFileSync(abs, 'utf8'));
    report.templates.push({ path: rel, sha256: sha256File(abs), resources: tpl.resources.length, transform: tpl.transform });
    if (tools['cfn-lint']) {
      const r = spawnSync(tools['cfn-lint'].bin, ['--format', 'sarif', '--', abs], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20, cwd: tmp, env: { PATH: process.env.PATH, HOME: tmp, LANG: 'C.UTF-8' } });
      let doc = null; try { doc = JSON.parse(r.stdout); } catch { doc = null; }
      if (!doc || !Array.isArray(doc.runs)) skipped.push({ step: 'cfn-lint', path: rel, reason: `cfn-lint exited ${r.status} without SARIF: ${String(r.stderr || '').trim().split('\n').slice(-1)[0] || ''}`.slice(0, 300) });
      else for (const run of doc.runs) for (const res of run.results || []) lint.push({ ...res, path: rel, uri: relUri(res.locations && res.locations[0] && res.locations[0].physicalLocation.artifactLocation.uri) });
    }
    for (const rs of ruleSets) {
      const r = spawnSync(tools['cfn-guard'].bin, ['validate', '--rules', rs.path, '--data', abs, '--output-format', 'sarif', '--structured', '--show-summary', 'none'], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 << 20, cwd: tmp, env: { PATH: process.env.PATH, HOME: tmp, LANG: 'C.UTF-8' } });
      let doc = null; try { doc = JSON.parse(r.stdout); } catch { doc = null; }
      // cfn-guard exits 19 when a rule fails, 0 when all pass; anything else is an error of its own.
      if (!doc || !Array.isArray(doc.runs) || ![0, 19].includes(r.status)) { skipped.push({ step: 'cfn-guard', path: rel, ruleSet: rs.name, reason: `cfn-guard exited ${r.status}: ${String(r.stderr || r.stdout || '').trim().split('\n').slice(-1)[0] || ''}`.slice(0, 300) }); continue; }
      for (const run of doc.runs) for (const res of run.results || []) guard.push({ ...res, path: rel, ruleSet: rs.name });
    }
    // 4 (template part). Live AWS checks come after the emulator.
    report.templates[report.templates.length - 1].stackName = stackFor(rel);
  }

  // 3. The emulator: once for all templates.
  if (flags['no-emulator']) report.emulator = { name: null, why: 'not run: --no-emulator' };
  else if (!templates.length) report.emulator = { name: null, why: 'no CloudFormation templates in the checkout' };
  else if (!awsBin) report.emulator = { name: null, why: 'the AWS CLI is not among this run\'s tools: no stack was created' };
  else {
    const port = Number(process.env.MAXWELL_CFN_EMULATOR_PORT || PINS.emulatorPort);
    const em = await startEmulator({ port, tmp, moto: motoOk ? { bin: motoBin, version: PINS.moto.version } : null, localstack: PINS.localstack });
    if (!em.name) report.emulator = { name: null, why: `no emulator ran: ${em.why}${motoBin && !motoOk ? `; moto_server at ${motoBin} is not the pinned ${PINS.moto.version}` : ''}` };
    else {
      report.emulator = { name: em.name, version: em.version, endpoint: em.ctx.endpoint, aws: awsVersion };
      try {
        for (const [i, rel] of templates.entries()) {
          const abs = join(checkout, rel);
          const tpl = readTemplate(readFileSync(abs, 'utf8'));
          if (tpl.transform) { emulated.push({ path: rel, tpl, result: { status: 'NOT_RUN', reason: `the template declares Transform ${tpl.transform}; the emulator does not expand transforms`, created: [], failed: [], posture: [], notVerified: tpl.resources.map((r) => ({ logicalId: r.logicalId, type: r.type, reason: 'not created: the template has a Transform' })) } }); continue; }
          let result = await verifyInEmulator(em, { templateFile: abs, tpl, stackName: `maxwell-verify-${i + 1}`, tmp, awsBin });
          // An emulator that crashed on the template (not a failure of the template's own) gets one more try without
          // the resources' Tags, from a scratch copy: the posture read back never depends on tags.
          if (result.status === 'EMULATOR_ERROR') {
            const copy = join(tmp, `template-${i + 1}-untagged${rel.endsWith('.json') ? '.json' : '.yaml'}`);
            writeFileSync(copy, withoutTags(readFileSync(abs, 'utf8')));
            const again = await verifyInEmulator(em, { templateFile: copy, tpl, stackName: `maxwell-verify-${i + 1}-untagged`, tmp, awsBin });
            again.firstAttempt = { status: result.status, reason: result.reason };
            again.withoutTags = true;
            if (again.status !== 'EMULATOR_ERROR' || again.created.length > result.created.length) result = again;
            else result.retriedWithoutTags = { status: again.status, reason: again.reason };
          }
          emulated.push({ path: rel, tpl, result });
        }
      } finally { em.stop(); }
      report.emulator.stacks = emulated.map((e) => ({ path: e.path, status: e.result.status, reason: e.result.reason, ...(e.result.withoutTags ? { createdWithoutTags: true, firstAttempt: e.result.firstAttempt } : {}),
        ...(e.result.retriedWithoutTags ? { retriedWithoutTags: e.result.retriedWithoutTags } : {}), created: e.result.created.length, failed: e.result.failed.length,
        notVerified: e.result.notVerified.length, parametersFilled: e.result.params, parametersMissing: e.result.paramsMissing }));
    }
  }

  // 4. The company's AWS account, read-only, when its credential is set.
  const cred = liveCredential();
  if (!cred.kind) report.liveAws = { ran: false, why: cred.why };
  else if (!awsBin) report.liveAws = { ran: false, why: 'the AWS CLI is not among this run\'s tools' };
  else {
    const region = process.env.MAXWELL_AWS_RO_REGION || envRegion || 'us-east-1';
    const lc = liveContext(cred, { region, awsBin, home: tmp });
    if (!lc.ctx) report.liveAws = { ran: false, credential: cred.kind, why: lc.why };
    else {
      report.liveAws = { ran: true, credential: cred.kind, region, account: lc.identity.account, templates: [] };
      for (const rel of templates) {
        const r = await liveChecks(lc.ctx, { templateFile: join(checkout, rel), stackName: stackFor(rel), awsBin, home: tmp });
        live.push({ path: rel, ...r });
        report.liveAws.templates.push({ path: rel, ...r });
      }
    }
  }

  const sarif = toSarif({ report, lint, guard, emulated, live, tools, ruleSets, pins: PINS, checkout });
  const redacted = redactSecrets(JSON.stringify(sarif, null, 2));
  const outPath = join(WORKSPACE, outRel);
  mkdirSync(dirname(outPath), { recursive: true });
  const text = `${redacted.text}\n`;
  writeFileSync(outPath, text);
  const counts = Object.fromEntries(sarif.runs.map((r) => [r.tool.driver.name, (r.results || []).length]));
  process.stdout.write(`${JSON.stringify({
    tool: 'cfn-verify', out: outRel, sha256: sha(text), templates: templates.length, results: counts,
    emulator: report.emulator && report.emulator.name ? `${report.emulator.name} ${report.emulator.version}` : `none (${report.emulator && report.emulator.why})`,
    liveAws: report.liveAws.ran ? `read-only, ${report.liveAws.credential}` : `not run (${report.liveAws.why})`,
    notVerified: emulated.reduce((n, e) => n + e.result.notVerified.length, 0), skipped: skipped.length, redactions: redacted.count,
  }, null, 2)}\n`);
}

main().catch((err) => { process.stderr.write(`${JSON.stringify({ error: err.code || 'failed', message: err.message })}\n`); process.exitCode = err.code === 'aws-policy' ? 2 : 5; })
  .finally(() => rmSync(tmp, { recursive: true, force: true }));
