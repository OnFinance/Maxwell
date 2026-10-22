// Host settings: one place that reads and writes the settings a self-hosted or hosted Maxwell needs outside a company's
// own records (models, price table, executor file, sandbox credentials directory, ComplianceOS login references).
// Precedence for every setting: its environment variable, then the host config file, then the built-in default. The
// file is ~/.config/maxwell/config.json (or MAXWELL_CONFIG_FILE), outside the workspace, and holds no secret value:
// secret-bearing settings store only the NAME of an environment variable. config/config.mjs is the only writer.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST_CONFIG_SCHEMA = 'https://maxwell.onfinance.ai/schemas/v1/harness/host-config.schema.json';
const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// kind: model | path | url | ref. A ref names an environment variable that carries a secret; `get` shows the name and
// whether that variable is set, never its value. outside: the path must not be inside the workspace.
export const HOST_SETTINGS = {
  'models.default': { env: 'MAXWELL_MODEL', kind: 'model', default: 'opus' },
  'models.fallback': { env: 'MAXWELL_FALLBACK_MODEL', kind: 'model' },
  'models.map.opus': { env: 'ANTHROPIC_DEFAULT_OPUS_MODEL', kind: 'model' },
  'models.map.sonnet': { env: 'ANTHROPIC_DEFAULT_SONNET_MODEL', kind: 'model' },
  'models.map.haiku': { env: 'ANTHROPIC_DEFAULT_HAIKU_MODEL', kind: 'model' },
  'pricing.file': { env: 'MAXWELL_PRICING_FILE', kind: 'path' },
  'executor.file': { env: 'MAXWELL_EXECUTOR_FILE', kind: 'path' },
  'sandbox.credentialsDir': { env: 'MAXWELL_SANDBOX_CREDENTIALS_DIR', kind: 'path', outside: true },
  'complianceos.baseUrl': { env: 'MAXWELL_COS_BASE_URL', kind: 'url' },
  'complianceos.credentialsFile': { env: 'MAXWELL_COS_CREDENTIALS_FILE', kind: 'path', outside: true },
  'complianceos.emailRef': { env: 'MAXWELL_COS_EMAIL', kind: 'ref' },
  'complianceos.passwordRef': { env: 'MAXWELL_COS_PASSWORD', kind: 'ref' },
  'complianceos.tokenRef': { env: 'MAXWELL_COS_TOKEN', kind: 'ref' },
};

export class ConfigError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const isInside = (dir, path) => {
  const rel = relative(resolve(dir), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

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
  if (!doc || doc.kind !== 'maxwell.host.config' || typeof doc.settings !== 'object') throw new ConfigError('invalid-config', `${path} is not a Maxwell host config`);
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
    const ref = cfg.settings[key];
    if (ref) return { key, value: ref, source: 'file', present: Boolean(env[ref]), secret: true };
    return { key, value: undefined, source: 'unset', present: false, secret: true };
  }
  if (env[spec.env]) return { key, value: env[spec.env], source: 'env' };
  const cfg = config || safeRead(env);
  if (cfg.settings[key] !== undefined) return { key, value: cfg.settings[key], source: 'file' };
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
// the problem instead.
function safeRead(env) {
  try { return readHostConfig(env); } catch { return emptyHostConfig(); }
}

export function checkValue(key, value, { ref = false } = {}) {
  const spec = HOST_SETTINGS[key];
  if (!spec) throw new ConfigError('unknown-key', `unknown setting ${key}; known: ${Object.keys(HOST_SETTINGS).join(', ')}`);
  if (spec.kind === 'ref' && !ref) throw new ConfigError('secret-value', `${key} holds a secret: give the name of the environment variable that carries it with --ref NAME, never the value`);
  if (spec.kind !== 'ref' && ref) throw new ConfigError('usage', `${key} is not a secret reference; give its value`);
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new ConfigError('invalid-value', `${key} needs a non-empty single-line value`);
  if (spec.kind === 'path') {
    if (!isAbsolute(value)) throw new ConfigError('invalid-value', `${key} must be an absolute path`);
    if (spec.outside && isInside(WORKSPACE, value)) throw new ConfigError('invalid-value', `${key} must be outside the workspace, not ${value}`);
  }
}

function writeAtomic(path, doc) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// validate: (doc) => null | 'error text' (the host-config schema validator; injected so this module stays light for
// hooks). by: who set it (a person's id, or "headless").
export function setHostSetting(key, value, { env = process.env, by = 'script', ref = false, validate } = {}) {
  checkValue(key, value, { ref });
  const path = hostConfigPath(env);
  if (isInside(WORKSPACE, path)) throw new ConfigError('invalid-value', `the host config must live outside the workspace, not ${path}`);
  const doc = readHostConfig(env);
  doc.settings = { ...doc.settings, [key]: value };
  doc.updated = { ...(doc.updated || {}), [key]: { at: now(), by } };
  const problem = validate ? validate(doc) : null;
  if (problem) throw new ConfigError('invalid-value', `${key} would not match the host config schema:\n${problem}`);
  writeAtomic(path, doc);
  return path;
}

export function unsetHostSetting(key, { env = process.env, by = 'script', validate } = {}) {
  if (!HOST_SETTINGS[key]) throw new ConfigError('unknown-key', `unknown setting ${key}`);
  const path = hostConfigPath(env);
  const doc = readHostConfig(env);
  if (!(key in doc.settings)) return path;
  const { [key]: _, ...rest } = doc.settings;
  doc.settings = rest;
  doc.updated = { ...(doc.updated || {}), [key]: { at: now(), by } };
  const problem = validate ? validate(doc) : null;
  if (problem) throw new ConfigError('invalid-value', problem);
  writeAtomic(path, doc);
  return path;
}

export { writeAtomic };
