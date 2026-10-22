// Host settings: one place that reads and writes the settings a self-hosted or hosted Maxwell needs outside a company's
// own records (models, price table, executor file, sandbox credentials directory, ComplianceOS login references).
// Precedence for every setting: its environment variable, then the host config file, then the built-in default. The
// file is ~/.config/maxwell/config.json (or MAXWELL_CONFIG_FILE), outside the workspace, and holds no secret value:
// secret-bearing settings store only the NAME of an environment variable. config/config.mjs is the only writer.
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST_CONFIG_SCHEMA = 'https://maxwell.onfinance.ai/schemas/v1/harness/host-config.schema.json';
const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// kind: model | path | url | ref. A ref names an environment variable that carries a secret; `get` shows the name and
// whether that variable is set, never its value. outside: the path must not be inside the workspace. guarded: the
// setting decides where secrets are kept or sent, so config.mjs stores it only under ~/.config/maxwell (paths), as an
// https origin (urls) or as a MAXWELL_/COS_ variable name (refs); its environment variable can still point anywhere.
export const HOST_SETTINGS = {
  'models.default': { env: 'MAXWELL_MODEL', kind: 'model', default: 'opus' },
  'models.fallback': { env: 'MAXWELL_FALLBACK_MODEL', kind: 'model' },
  'models.map.opus': { env: 'ANTHROPIC_DEFAULT_OPUS_MODEL', kind: 'model' },
  'models.map.sonnet': { env: 'ANTHROPIC_DEFAULT_SONNET_MODEL', kind: 'model' },
  'models.map.haiku': { env: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', kind: 'model' },
  'pricing.file': { env: 'MAXWELL_PRICING_FILE', kind: 'path' },
  'executor.file': { env: 'MAXWELL_EXECUTOR_FILE', kind: 'path' },
  'sandbox.credentialsDir': { env: 'MAXWELL_SANDBOX_CREDENTIALS_DIR', kind: 'path', outside: true, guarded: true },
  'complianceos.baseUrl': { env: 'MAXWELL_COS_BASE_URL', kind: 'url', guarded: true },
  'complianceos.credentialsFile': { env: 'MAXWELL_COS_CREDENTIALS_FILE', kind: 'path', outside: true, guarded: true },
  'complianceos.emailRef': { env: 'MAXWELL_COS_EMAIL', kind: 'ref', guarded: true },
  'complianceos.passwordRef': { env: 'MAXWELL_COS_PASSWORD', kind: 'ref', guarded: true },
  'complianceos.tokenRef': { env: 'MAXWELL_COS_TOKEN', kind: 'ref', guarded: true },
};

export class ConfigError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
// Resolves symlinks in the longest existing prefix of a path, so a link into the workspace cannot pass for outside.
function realish(path) {
  let head = resolve(path); const tail = [];
  while (!existsSync(head)) { const up = dirname(head); if (up === head) break; tail.unshift(head.slice(up.length + (up.endsWith('/') ? 0 : 1))); head = up; }
  try { head = realpathSync(head); } catch { /* keep as resolved */ }
  return join(head, ...tail);
}
export const isInside = (dir, path) => {
  const rel = relative(realish(dir), realish(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
export const ORIGIN = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?\/?$/i;
const REF_NAME = /^(?:MAXWELL|COS|COMPLIANCEOS)_[A-Z0-9_]{1,100}$/;

export function hostConfigPath(env = process.env) {
  return env.MAXWELL_CONFIG_FILE || join(env.HOME || homedir(), '.config', 'maxwell', 'config.json');
}

export function emptyHostConfig() {
  return { schemaVersion: '1', kind: 'maxwell.host.config', settings: {}, updated: {} };
}

// A missing file is an empty config; an unreadable or malformed one is an error, so a typo never silently resets
// every setting to its default.
export function readHostConfig(env = process.env) {
  const path = hostConfigPath(env);
  if (!existsSync(path)) return emptyHostConfig();
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (err) { throw new ConfigError('invalid-config', `${path} is not valid JSON: ${err.message}`); }
  if (!doc || doc.kind !== 'maxwell.host.config' || !doc.settings || typeof doc.settings !== 'object' || Array.isArray(doc.settings)) throw new ConfigError('invalid-config', `${path} is not a Maxwell host config`);
  return { updated: {}, ...doc };
}

// Value of one setting with where it came from. For a ref, value is the variable NAME (the configured reference, or
// the setting's own variable when that is set directly) and `present` says whether the variable holds a value.
export function hostSetting(key, env = process.env, config) {
  const spec = HOST_SETTINGS[key];
  if (!spec) throw new ConfigError('unknown-key', `unknown setting ${key}; known: ${Object.keys(HOST_SETTINGS).join(', ')}`);
  if (spec.kind === 'ref') {
    if (env[spec.env]) return { key, value: spec.env, source: 'env', present: true, secret: true };
    const cfg = config || safeRead(env);
    const ref = fileValue(cfg, key, env);
    if (ref) return { key, value: ref, source: 'file', present: Boolean(env[ref]), secret: true };
    return { key, value: undefined, source: 'unset', present: false, secret: true };
  }
  if (env[spec.env]) return { key, value: env[spec.env], source: 'env' };
  const cfg = config || safeRead(env);
  const v = fileValue(cfg, key, env);
  if (v !== undefined) return { key, value: v, source: 'file' };
  if (spec.default !== undefined) return { key, value: spec.default, source: 'default' };
  return { key, value: undefined, source: 'unset' };
}

// Plain value for callers that only need it (env > file > default), or undefined. A ref resolves to the secret held
// by the referenced variable, for use in-process only; never print it.
export function settingValue(key, env = process.env, config) {
  const s = hostSetting(key, env, config);
  if (HOST_SETTINGS[key].kind === 'ref') return s.value ? env[s.value] || undefined : undefined;
  return s.value;
}

// Readers that run inside hooks and helpers must not fail because the host file is broken; the config command reports
// the problem instead. A file value that could not have been written by config.mjs is ignored the same way.
function safeRead(env) {
  try { return readHostConfig(env); } catch { return emptyHostConfig(); }
}
function fileValue(cfg, key, env = process.env) {
  const v = cfg && cfg.settings ? cfg.settings[key] : undefined;
  if (typeof v !== 'string' || !v) return undefined;
  try { checkValue(key, v, { ref: HOST_SETTINGS[key].kind === 'ref', env }); } catch { return undefined; }
  return v;
}
export function hostConfigProblems(env = process.env) {
  const cfg = readHostConfig(env);
  return Object.keys(cfg.settings).filter((k) => !HOST_SETTINGS[k] || fileValue(cfg, k, env) === undefined).map((k) => `${k} is not a valid setting value and is ignored`);
}

export function checkValue(key, value, { ref = false, env = process.env } = {}) {
  const spec = HOST_SETTINGS[key];
  if (!spec) throw new ConfigError('unknown-key', `unknown setting ${key}; known: ${Object.keys(HOST_SETTINGS).join(', ')}`);
  if (spec.kind === 'ref' && !ref) throw new ConfigError('secret-value', `${key} holds a secret: give the name of the environment variable that carries it with --ref NAME, never the value`);
  if (spec.kind !== 'ref' && ref) throw new ConfigError('usage', `${key} is not a secret reference; give its value`);
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new ConfigError('invalid-value', `${key} needs a non-empty single-line value`);
  if (value.length > 1024) throw new ConfigError('invalid-value', `${key} is too long`);
  if (spec.kind === 'path') {
    if (!isAbsolute(value)) throw new ConfigError('invalid-value', `${key} must be an absolute path`);
    if (spec.outside && isInside(WORKSPACE, value)) throw new ConfigError('invalid-value', `${key} must be outside the workspace, not ${value}`);
    // Agents are denied file access to ~/.config/maxwell; a stored secret folder or login file stays under it.
    const home = join(env.HOME || homedir(), '.config', 'maxwell');
    if (spec.guarded && !isInside(home, value)) throw new ConfigError('invalid-value', `${key} must be under ${home}; to keep it elsewhere, set ${spec.env} in the environment that starts Maxwell`);
  }
  if (spec.kind === 'model' && !/^[A-Za-z0-9./:_@\[\]-]{1,128}$/.test(value)) throw new ConfigError('invalid-value', `${key} must be a model id such as claude-opus-5-5`);
  if (spec.kind === 'url' && !ORIGIN.test(value)) throw new ConfigError('invalid-value', `${key} must be an https origin such as https://host.example`);
  if (spec.kind === 'ref' && !REF_NAME.test(value)) throw new ConfigError('invalid-value', `${key} must name a variable starting MAXWELL_, COS_ or COMPLIANCEOS_ (so no other credential in the environment can be sent as a login)`);
}

function writeAtomic(path, doc, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}

// validate: (doc) => null | 'error text' (the host-config schema validator; injected so this module stays light for
// hooks). by: who set it (a person's id, or "headless").
export function setHostSetting(key, value, { env = process.env, by = 'script', ref = false, validate } = {}) {
  checkValue(key, value, { ref, env });
  const path = hostConfigPath(env);
  if (isInside(WORKSPACE, path)) throw new ConfigError('invalid-value', `the host config must live outside the workspace, not ${path}`);
  const doc = readHostConfig(env);
  doc.settings = { ...doc.settings, [key]: value };
  doc.updated = { ...(doc.updated || {}), [key]: { at: now(), by: String(by).slice(0, 200) } };
  const problem = validate ? validate(doc) : null;
  if (problem) throw new ConfigError('invalid-value', `${key} would not match the host config schema:\n${problem}`);
  writeAtomic(path, doc);
  return path;
}

export function unsetHostSetting(key, { env = process.env, by = 'script', validate } = {}) {
  if (!HOST_SETTINGS[key]) throw new ConfigError('unknown-key', `unknown setting ${key}`);
  const path = hostConfigPath(env);
  if (isInside(WORKSPACE, path)) throw new ConfigError('invalid-value', `the host config must live outside the workspace, not ${path}`);
  const doc = readHostConfig(env);
  if (!(key in doc.settings)) return path;
  const { [key]: _, ...rest } = doc.settings;
  doc.settings = rest;
  doc.updated = { ...(doc.updated || {}), [key]: { at: now(), by: String(by).slice(0, 200) } };
  const problem = validate ? validate(doc) : null;
  if (problem) throw new ConfigError('invalid-value', problem);
  writeAtomic(path, doc);
  return path;
}

export { writeAtomic };
