#!/usr/bin/env node
// Reads and writes Maxwell's settings. The only way agents (and the /config command) change them: never edit the
// host config file or a company's executor.json by hand.
// Usage:
//   config.mjs keys                                                 every setting, its environment variable and kind
//   config.mjs get [<key>] [--company <company_id>]                 current values and where each comes from
//   config.mjs set <key> <value> [--by <who>]                       a host setting
//   config.mjs set <key> --ref <ENV_NAME> [--by <who>]              a secret-bearing setting: the NAME of the variable
//   config.mjs set executor --company <c> --from-file <path> [--accept-residency]
//                                                                    a company's executor document (validated)
//   config.mjs unset <key> [--by <who>]
// Host settings live in ~/.config/maxwell/config.json (or MAXWELL_CONFIG_FILE), outside the workspace; each one's
// environment variable wins over the file. Secret values are never accepted, stored or printed: a secret-bearing
// setting holds the name of an environment variable, and `get` shows that name and whether it is set. Settings that
// decide where secrets are kept or sent accept only safe values here (see lib/config.mjs `guarded`); .claude/settings.json
// asks the person before an agent runs `set` or `unset`.
// Prints one JSON object. Exit codes: 0 done, 2 refused (unknown key, invalid value, a secret given as a value).
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAjv, getValidator, formatErrors } from '../lib/schemas.mjs';
import { ConfigError, HOST_CONFIG_SCHEMA, HOST_SETTINGS, hostConfigPath, hostConfigProblems, hostSetting, setHostSetting, unsetHostSetting, writeAtomic } from '../lib/config.mjs';
import { EXECUTOR_SCHEMA, executorPath, executorSource, loadExecutor } from '../lib/sandbox/index.mjs';
import { residencyProblem } from '../lib/sandbox/common.mjs';
import { WORKSPACE } from '../lib/toolchain.mjs';

const COMPANY_KEYS = { executor: 'company-profile/<company_id>/sdlc/executor.json: where pinned scanners and runtime probe commands run (schema company/executor)' };
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const out = (o) => console.log(JSON.stringify(o, null, 2));
function fail(code, message) {
  console.log(JSON.stringify({ ok: false, error: code, message }, null, 2));
  process.exit(2);
}

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: { company: { type: 'string' }, 'from-file': { type: 'string' }, ref: { type: 'string' }, by: { type: 'string' }, 'accept-residency': { type: 'boolean' } },
  });
} catch (err) { fail('usage', err.message); }
const { values: flags, positionals: [cmd, key, value] } = parsed;
const by = String(flags.by || process.env.MAXWELL_INVOKED_BY || 'headless').slice(0, 120);

const ajv = () => buildAjv().ajv;
const hostValidator = () => {
  const check = getValidator(ajv(), HOST_CONFIG_SCHEMA);
  return (doc) => (check(doc) ? null : formatErrors(check.errors));
};
const descriptions = () => JSON.parse(readFileSync(join(WORKSPACE, '.claude/schemas/v1/harness/host-config.schema.json'), 'utf8')).properties.settings.properties;

// One host setting for display: secret-bearing settings show only the variable name and whether it is set.
function show(k) {
  const s = hostSetting(k);
  const spec = HOST_SETTINGS[k];
  if (spec.kind === 'ref') return { key: k, ref: s.value || null, set: s.present, source: s.source, env: spec.env };
  return { key: k, value: s.value === undefined ? null : s.value, source: s.source, env: spec.env };
}

function needCompany() {
  if (!flags.company || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(flags.company)) fail('usage', '--company <company_id> is required for company settings');
  if (!existsSync(join(WORKSPACE, 'company-profile', flags.company, 'details.json'))) fail('usage', `company-profile/${flags.company}/details.json does not exist`);
}

function showExecutor() {
  const src = executorSource(flags.company, { root: WORKSPACE });
  const rel = src.path.startsWith(`${WORKSPACE}/`) ? src.path.slice(WORKSPACE.length + 1) : src.path;
  const from = src.override ? `executor.file (${src.source})` : 'company';
  let doc;
  try { doc = loadExecutor(flags.company, { root: WORKSPACE }); } catch (err) { return { key: 'executor', company: flags.company, configured: false, path: rel, source: from, problem: err.message }; }
  if (!doc) return { key: 'executor', company: flags.company, configured: false, path: rel, source: from };
  // The executor document holds provider names and non-secret settings only; still, only the choices are shown.
  return { key: 'executor', company: flags.company, configured: true, path: rel, source: from, static: doc.static, runtime: doc.runtime, providers: Object.keys(doc.providers || {}) };
}

function readValueFile(path) {
  if (!existsSync(path)) fail('usage', `${path} does not exist`);
  return readFileSync(path, 'utf8');
}

try {
  switch (cmd) {
    case 'keys': {
      const d = descriptions();
      out({
        host: { file: hostConfigPath(), settings: Object.entries(HOST_SETTINGS).map(([k, s]) => ({ key: k, env: s.env, kind: s.kind, secret: s.kind === 'ref', description: d[k] && d[k].description })) },
        company: Object.entries(COMPANY_KEYS).map(([k, description]) => ({ key: k, description })),
      });
      break;
    }
    case 'get': {
      if (key === 'executor') { needCompany(); out(showExecutor()); break; }
      if (key) {
        if (!HOST_SETTINGS[key]) fail('unknown-key', `unknown setting ${key}; run \`config.mjs keys\``);
        out(show(key));
        break;
      }
      let problems = [];
      try { problems = hostConfigProblems(); } catch (err) { problems = [err.message]; }
      out({ file: hostConfigPath(), ...(problems.length ? { fileProblem: problems.join('; ') } : {}), settings: Object.keys(HOST_SETTINGS).map(show), ...(flags.company ? (needCompany(), { executor: showExecutor() }) : {}) });
      break;
    }
    case 'set': {
      if (!key) fail('usage', 'usage: config.mjs set <key> <value> | --ref <ENV_NAME>, or set executor --company <c> --from-file <path>');
      if (key === 'executor') {
        needCompany();
        if (!flags['from-file']) fail('usage', 'set executor needs --from-file <executor.json>; /connect-sandbox builds one step by step');
        const src = executorSource(flags.company, { root: WORKSPACE });
        if (src.override) fail('overridden', 'the host setting executor.file supplies this executor, so a change to the company file would not take effect; clear it with `config.mjs unset executor.file` first');
        let doc;
        try { doc = JSON.parse(readValueFile(flags['from-file'])); } catch (err) { fail('invalid-value', `${flags['from-file']} is not JSON: ${err.message}`); }
        if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('invalid-value', 'the executor must be a JSON object');
        if (doc.companyId !== flags.company) fail('invalid-value', `the executor is for company ${doc.companyId}, not ${flags.company}`);
        const residency = residencyProblem(doc, JSON.parse(readFileSync(join(WORKSPACE, 'company-profile', flags.company, 'details.json'), 'utf8')));
        if (residency && !flags['accept-residency']) fail('residency', `${residency}. Use an Indian region, or pass --accept-residency after the user explicitly accepts that checkouts are scanned outside India.`);
        doc.provenance = { harness: process.env.MAXWELL_HARNESS || 'script', generatedAt: now(), ...(process.env.MAXWELL_RUN_ID ? { runId: process.env.MAXWELL_RUN_ID } : {}), workflow: 'config', agent: `.claude/scripts/config/config.mjs (${by})`.slice(0, 200) };
        const check = getValidator(ajv(), EXECUTOR_SCHEMA);
        if (!check(doc)) fail('invalid-value', `the executor would not match its schema:\n${formatErrors(check.errors)}`);
        const path = executorPath(flags.company, WORKSPACE);
        writeAtomic(path, doc);
        out({ ok: true, key: 'executor', company: flags.company, written: path.slice(WORKSPACE.length + 1), static: doc.static, runtime: doc.runtime, next: `node .claude/scripts/sandbox/connect.mjs test --company ${flags.company}` });
        break;
      }
      if (!HOST_SETTINGS[key]) fail('unknown-key', `unknown setting ${key}; run \`config.mjs keys\``);
      // Host settings are short, non-secret values typed by a person; they are never read from a file, so this tool
      // cannot be used to read and echo arbitrary files.
      if (flags['from-file'] !== undefined) fail('usage', '--from-file is only for set executor; give the value itself or --ref <ENV_NAME>');
      const given = [value !== undefined, flags.ref !== undefined].filter(Boolean).length;
      if (given !== 1) fail('usage', 'give exactly one of <value> or --ref <ENV_NAME>');
      const isRef = flags.ref !== undefined;
      // A secret-bearing setting refuses a value before reading it anywhere, so nothing echoes it back.
      if (HOST_SETTINGS[key].kind === 'ref' && !isRef) fail('secret-value', `${key} holds a secret: set it as --ref <ENV_NAME>, the name of the environment variable that carries it, never the value`);
      const v = isRef ? flags.ref : value;
      const file = setHostSetting(key, v, { ref: isRef, by, validate: hostValidator() });
      out({ ok: true, file, ...show(key) });
      break;
    }
    case 'unset': {
      if (!key || !HOST_SETTINGS[key]) fail('unknown-key', `unknown setting ${key || '(none)'}; run \`config.mjs keys\``);
      const file = unsetHostSetting(key, { by, validate: hostValidator() });
      out({ ok: true, file, ...show(key) });
      break;
    }
    default:
      fail('usage', 'usage: config.mjs keys | get [<key>] [--company <c>] | set <key> <value>|--ref <ENV_NAME> | set executor --company <c> --from-file <path> | unset <key>');
  }
} catch (err) {
  if (err instanceof ConfigError) fail(err.code, err.message);
  fail('error', err.message);
}
