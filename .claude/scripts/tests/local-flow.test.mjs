import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE } from '../lib/toolchain.mjs';

// Maxwell must stay fully runnable on a person's own machine exactly as before the host settings existed: no new
// required setting, no new variable, no extra permission prompt. The expected values below are what main printed and
// passed on at 0e78030 (before the config tool), recorded with the same stand-in `claude` and an empty home folder.
// Hosted behaviour appears only once a host config file or one of its variables is set (see config.test.mjs).

// Only these variables are passed to the scripts: no Maxwell, model, ComplianceOS or host-config variable leaks in.
const baseEnv = (home, bin, extra = {}) => ({ PATH: `${bin}:${process.env.PATH}`, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), ...extra });

// A throwaway workspace with an empty home and a stand-in `claude` that records its arguments and the Maxwell and
// model variables it was given, then answers like `claude -p --output-format json`. No model is called.
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'maxwell-local-'));
  const home = join(dir, 'home'); const bin = join(dir, 'bin'); const ws = join(dir, 'ws'); const log = join(dir, 'claude.log');
  for (const d of [home, bin, join(ws, 'kpis'), join(ws, '.claude')]) mkdirSync(d, { recursive: true });
  copyFileSync(join(WORKSPACE, 'kpis/metrics.json'), join(ws, 'kpis/metrics.json'));
  for (const d of ['schemas', 'skills']) symlinkSync(join(WORKSPACE, '.claude', d), join(ws, '.claude', d));
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === '--version') { console.log('9.9.9 (stand-in)'); process.exit(0); }
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(MAXWELL_|ANTHROPIC_)/.test(k)).sort());
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: a, env }) + '\\n');
const i = a.indexOf('--session-id');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: a[i + 1], total_cost_usd: 0, num_turns: 1, result: 'ok' }));
`);
  chmodSync(join(bin, 'claude'), 0o755);
  return { dir, home, bin, ws, log };
}

const norm = (s) => String(s)
  .replace(/run_[0-9A-HJKMNP-TV-Z]{26}/g, 'run_<ULID>')
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<UUID>')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, '<TIME>');

function headless(w, args, extra = {}) {
  rmSync(w.log, { force: true });
  const r = spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/run-headless.mjs'), ...args], { cwd: w.ws, encoding: 'utf8', env: baseEnv(w.home, w.bin, extra) });
  const calls = existsSync(w.log) ? readFileSync(w.log, 'utf8').trim().split('\n').map((l) => JSON.parse(norm(l))) : [];
  const err = norm(r.stderr).split('\n');
  assert.deepEqual(err.filter((l) => l.startsWith('[maxwell]')), [], 'no new warnings');
  return { calls, lines: err.filter((l) => l.startsWith('[run-headless]')) };
}

const PROMPT = 'Run /probe-iac with exactly this args object, passed as structured data (not a string), and report its result: {"companyId":"example-co","appIds":[],"envIds":[],"dryRun":true,"now":"<TIME>","runId":"run_<ULID>","sessionId":"<UUID>"}';
const argvOf = (model, fallback, prompt = PROMPT) => ['-p', '--output-format', 'json', '--session-id', '<UUID>', '--model', model, '--permission-mode', 'auto', '--max-turns', '400', '--setting-sources', 'project', ...(fallback ? ['--fallback-model', fallback] : []), prompt];
const envOf = (model, extra = {}) => ({ ...extra, MAXWELL_HARNESS: 'claude-code', MAXWELL_INVOKED_BY: '', MAXWELL_KPI_SAMPLE: '1', MAXWELL_MODEL: model, MAXWELL_RUN_ID: 'run_<ULID>' });
const linesOf = (model, fallback, prompt = PROMPT, workflow = true) => [
  `[run-headless] claude ${argvOf(model, fallback, prompt).map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`,
  `[run-headless] model=${model} session <UUID> turns=1 cost=0 denials=0 outcome=success`,
  ...(workflow ? ['[run-headless] probe-iac did not complete: launched=false status=none failedAgents=0 outcome=error: the session ended without launching the workflow (transcript not found)'] : []),
];

test('with no host config and no new variables, headless runs pass claude exactly what they did before', () => {
  const w = workspace();
  try {
    const iac = ['--workflow', 'probe-iac', '--company', 'example-co', '--dry-run'];
    const cases = [
      { name: 'default', args: iac, extra: {}, model: 'opus', fallback: '' },
      { name: 'model variables', args: iac, extra: { MAXWELL_MODEL: 'sonnet', MAXWELL_FALLBACK_MODEL: 'haiku' }, model: 'sonnet', fallback: 'haiku', env: { MAXWELL_FALLBACK_MODEL: 'haiku' } },
      { name: 'alias variable already set', args: iac, extra: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-x' }, model: 'opus', fallback: '', env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-x' } },
      { name: '--model flag', args: [...iac, '--model', 'fable'], extra: {}, model: 'fable', fallback: 'opus' },
      { name: 'utility command', args: ['--workflow', 'status', '--company', 'example-co'], extra: {}, model: 'opus', fallback: '', prompt: '/status example-co', workflow: false },
    ];
    for (const c of cases) {
      const r = headless(w, c.args, c.extra);
      assert.equal(r.calls.length, 1, c.name);
      assert.deepEqual(r.calls[0].argv, argvOf(c.model, c.fallback, c.prompt), c.name);
      assert.deepEqual(r.calls[0].env, envOf(c.model, c.env || {}), `${c.name}: no new variables`);
      assert.deepEqual(r.lines, linesOf(c.model, c.fallback, c.prompt, c.workflow !== false), `${c.name}: no new output lines`);
    }
    assert.ok(!existsSync(join(w.home, '.config')), 'nothing is written to the home folder');
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('local helpers print what they printed before', () => {
  const w = workspace();
  try {
    const run = (args, extra = {}) => {
      const r = spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts', ...args.slice(0, 1)), ...args.slice(1)], { cwd: WORKSPACE, encoding: 'utf8', env: baseEnv(w.home, w.bin, extra) });
      return { status: r.status, out: r.stdout.split(w.home).join('<HOME>'), err: r.stderr };
    };
    const json = (o) => `${JSON.stringify(o, null, 2)}\n`;
    assert.deepEqual(run(['cos/search.mjs', 'status']), { status: 0, out: json({ configured: false, source: null, baseUrl: 'https://complianceos-prod.onfinance.ai', credentialsFile: null, tokenCached: false }), err: '' });
    assert.deepEqual(run(['cos/search.mjs', 'status'], { MAXWELL_COS_EMAIL: 'a.person@example.com', MAXWELL_COS_PASSWORD: 'pw-not-real', MAXWELL_COS_BASE_URL: 'https://cos.example.com' }),
      { status: 0, out: json({ configured: true, source: 'env', baseUrl: 'https://cos.example.com', email: 'a***@example.com', credentialsFile: null, tokenCached: false }), err: '' });
    mkdirSync(join(w.home, '.config', 'maxwell'), { recursive: true });
    writeFileSync(join(w.home, '.config', 'maxwell', 'complianceos.env'), 'MAXWELL_COS_BASE_URL=https://file.example.com\nMAXWELL_COS_EMAIL=file.person@example.com\nMAXWELL_COS_PASSWORD=pw-file\n', { mode: 0o600 });
    const fromFile = run(['cos/search.mjs', 'status']);
    assert.deepEqual(fromFile, { status: 0, out: json({ configured: true, source: 'file', baseUrl: 'https://file.example.com', email: 'f***@example.com', credentialsFile: '<HOME>/.config/maxwell/complianceos.env', tokenCached: false }), err: '' });
    assert.doesNotMatch(fromFile.out, /pw-file|file\.person/, 'the stored login is never printed');
    // hdfc-amc ships without an executor (config.test.mjs writes example-co's, possibly in parallel); a checkout where
    // someone ran /connect-sandbox for it has nothing to compare against.
    if (!existsSync(join(WORKSPACE, 'company-profile/hdfc-amc/sdlc/executor.json'))) {
      assert.deepEqual(run(['sandbox/connect.mjs', 'status', '--company', 'hdfc-amc']), { status: 0, out: json({ configured: false, action: 'run /connect-sandbox' }), err: '' });
    }
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

// The permission rules main shipped; the config tool may only add allow rules for its own /config command.
const MAIN_ASK = ['Bash(ssh *)', 'Bash(curl *)', 'Bash(git push *)'];
const MAIN_DENY = ['Read(./applications/*/credentials.dec.json)', 'Read(./.sops-key.txt)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)', 'Read(~/.config/gcloud/**)', 'Read(~/.kube/**)', 'Read(~/.config/maxwell/**)', 'Read(~/.cache/maxwell/**)', 'Bash(sops --decrypt *)', 'Bash(sops -d *)', 'Bash(rm -rf *)', 'Bash(git push --force *)', 'Write(./applications/*/repos/*/**)', 'Edit(./applications/*/repos/*/**)'];
const MAIN_OC_BASH = { '*': 'ask', 'npm run *': 'allow', 'npm test*': 'allow', 'node .claude/scripts/*': 'allow', 'npx jsonschema *': 'allow', 'git status*': 'allow', 'git diff*': 'allow', 'git log*': 'allow', 'sops --decrypt *': 'deny', 'sops -d *': 'deny', '*.config/maxwell/*': 'deny', '*.cache/maxwell/*': 'deny', 'rm -rf *': 'deny', 'git push --force*': 'deny' };
const glob = (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 's');

test('the permission rules add no prompt and no denial to the local flow', () => {
  const settings = JSON.parse(readFileSync(join(WORKSPACE, '.claude/settings.json'), 'utf8')).permissions;
  const oc = JSON.parse(readFileSync(join(WORKSPACE, 'opencode.json'), 'utf8'));
  assert.deepEqual(settings.ask, MAIN_ASK, 'Claude Code asks about nothing new');
  assert.deepEqual(settings.deny, MAIN_DENY, 'Claude Code denies nothing new');
  assert.deepEqual(oc.permission.bash, MAIN_OC_BASH, 'OpenCode asks about and denies nothing new');
  for (const [name, agent] of Object.entries(oc.agent)) {
    const bash = agent.permission && typeof agent.permission.bash === 'object' ? Object.keys(agent.permission.bash) : [];
    assert.deepEqual(bash.filter((p) => /config\.mjs|\.\./.test(p)), [], `${name}: no new denial`);
  }
  // What a person runs locally, including paths with "..": allowed without a prompt in both harnesses.
  const local = [
    'node .claude/scripts/apps/add.mjs ../payments-api.json --dry-run',
    'node .claude/scripts/apps/add.mjs payments-api.json --checkout',
    'node .claude/scripts/cos/search.mjs search --query "cyber resilience..." --regulator SEBI',
    'node .claude/scripts/sandbox/connect.mjs status --company example-co',
    'node .claude/scripts/run-headless.mjs --workflow probe-iac --company example-co --dry-run',
    'node .claude/scripts/validate-data.mjs ../outside.json',
    'node .claude/scripts/config/config.mjs get',
    'node .claude/scripts/config/config.mjs set models.default sonnet --by me',
    'node .claude/scripts/config/config.mjs unset models.default',
  ];
  const bashRules = (list) => list.map((r) => /^Bash\((.*)\)$/s.exec(r)).filter(Boolean).map((m) => glob(m[1]));
  const [allow, ask, deny] = [settings.allow, settings.ask, settings.deny].map(bashRules);
  for (const cmd of local) {
    assert.ok(allow.some((r) => r.test(cmd)) && !ask.some((r) => r.test(cmd)) && !deny.some((r) => r.test(cmd)), `Claude Code runs without a prompt: ${cmd}`);
    // OpenCode applies the last matching rule.
    const decision = Object.entries(oc.permission.bash).filter(([p]) => glob(p).test(cmd)).pop();
    assert.equal(decision && decision[1], 'allow', `OpenCode runs without a prompt: ${cmd}`);
  }
});

test('a person changes their own settings with no extra variable, and only then does a run change', () => {
  const w = workspace();
  try {
    const cfg = (...args) => spawnSync(process.execPath, [join(WORKSPACE, '.claude/scripts/config/config.mjs'), ...args], { cwd: WORKSPACE, encoding: 'utf8', env: baseEnv(w.home, w.bin) });
    const set = cfg('set', 'models.map.opus', 'claude-opus-5-5', '--by', 'me');
    assert.equal(set.status, 0, set.stdout + set.stderr);
    assert.ok(existsSync(join(w.home, '.config/maxwell/config.json')), 'kept in the home folder, outside the workspace');
    const iac = ['--workflow', 'probe-iac', '--company', 'example-co', '--dry-run'];
    const mapped = headless(w, iac);
    assert.equal(mapped.calls[0].env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-opus-5-5', 'the person\'s own setting takes effect');
    assert.equal(mapped.lines[0], '[run-headless] opus runs on claude-opus-5-5');
    const unset = cfg('unset', 'models.map.opus');
    assert.equal(unset.status, 0, unset.stdout + unset.stderr);
    const back = headless(w, iac);
    assert.deepEqual(back.calls[0].env, envOf('opus'), 'with the setting cleared, the run is as before');
    assert.deepEqual(back.lines, linesOf('opus', ''));
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

// A company's own catalogs (company-profile/<c>/catalogs/) reach only that company's runs. A company without them,
// even beside a company that has them, gets exactly the prompt, variables and output lines main gave it.
test('company catalogs change nothing for a company without them, and reach only their own company', () => {
  const w = workspace();
  try {
    const catalog = (c, slug) => {
      mkdirSync(join(w.ws, 'company-profile', c, 'catalogs'), { recursive: true });
      writeFileSync(join(w.ws, 'company-profile', c, 'catalogs', `${slug}.catalog.json`), JSON.stringify({ schemaVersion: '1', kind: 'maxwell.catalog.company', companyId: c, instrumentId: `co:${c}:${slug}`, regulator: 'SEBI', title: 'Sector circular', groups: [{ id: 'A', title: 'A', controls: [{ id: 'C-1', title: 'C', prose: 'C', mandatory: false }] }] }));
    };
    mkdirSync(join(w.ws, 'company-profile', 'example-co'), { recursive: true });
    catalog('other-co', 'circular');
    const iac = ['--workflow', 'probe-iac', '--company', 'example-co', '--dry-run'];
    const before = headless(w, iac);
    assert.deepEqual(before.calls[0].argv, argvOf('opus', ''), 'the prompt is exactly as on main');
    assert.deepEqual(before.calls[0].env, envOf('opus'));
    assert.deepEqual(before.lines, linesOf('opus', ''));
    catalog('example-co', 'circular');
    const after = headless(w, iac);
    const prompt = after.calls[0].argv[after.calls[0].argv.length - 1];
    const args = JSON.parse(prompt.slice(prompt.indexOf('{')));
    assert.deepEqual(args.companyCatalogs, [{ instrumentId: 'co:example-co:circular', file: 'company-profile/example-co/catalogs/circular.catalog.json', regulator: 'SEBI', controls: 1 }]);
    assert.doesNotMatch(prompt, /other-co/, 'another company\'s catalog never reaches this run');
    assert.deepEqual(after.calls[0].env, envOf('opus'), 'no new variables');
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

// Claude Code reads Write/Edit path rules with gitignore semantics ("./" is the project root, "*" one path segment,
// "**" any depth). The checkouts under applications/<app_id>/repos/<repo_id>/ are never edited; the repository records
// beside them (applications/<app_id>/repos/<repo_id>.json) are what refresh-apps' validator and probe-sdlc write.
const pathRule = (rule) => {
  const m = /^(Write|Edit)\(\.\/(.*)\)$/s.exec(rule);
  if (!m) return null;
  const body = m[2].split('/').map((seg) => (seg === '**' ? '.*' : seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))).join('/');
  // A trailing "/**" is everything inside, never the directory itself (gitignore).
  return { tool: m[1], re: new RegExp(`^${body.replace(/\/\.\*$/, '/.+')}$`) };
};
test('a repository record beside its checkout can be written; the checkout itself cannot', () => {
  const deny = JSON.parse(readFileSync(join(WORKSPACE, '.claude/settings.json'), 'utf8')).permissions.deny.map(pathRule).filter(Boolean);
  const denied = (tool, p) => deny.some((r) => r.tool === tool && r.re.test(p));
  for (const tool of ['Write', 'Edit']) {
    for (const p of ['applications/payments-api/repos/payments.json', 'applications/maxwell/repos/maxwell.json'])
      assert.equal(denied(tool, p), false, `${tool} ${p}: the repository record is writable (refresh-apps writes it)`);
    for (const p of ['applications/payments-api/repos/payments/src/app.ts', 'applications/maxwell/repos/maxwell/.git/config', 'applications/maxwell/repos/maxwell/README.md'])
      assert.equal(denied(tool, p), true, `${tool} ${p}: inside a checkout, denied`);
  }
  // The rule this replaced also caught the records: refresh-apps' Write stage was refused and the record kept
  // add.mjs's placeholders (Maxwell hosted, 2026-10-30).
  assert.equal(pathRule('Write(./applications/*/repos/**)').re.test('applications/maxwell/repos/maxwell.json'), true);
});
