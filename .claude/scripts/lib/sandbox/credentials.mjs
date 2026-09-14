// Sandbox provider credentials live outside the workspace in ~/.config/maxwell/sandbox/<provider>.env (mode 0600;
// .claude/settings.json denies agent file tools on ~/.config/maxwell). Only variable names appear in the workspace.
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { parseEnvFile } from '../complianceos.mjs';
import { WORKSPACE } from '../toolchain.mjs';
import { ExecutorError } from './common.mjs';

export const PROVIDER_CREDENTIALS = {
  e2b: ['E2B_API_KEY'],
  daytona: ['DAYTONA_API_KEY'],
  modal: ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'],
  vercel: ['VERCEL_TOKEN'],
  // The AWS SDK default chain (a profile, SSO or an instance role); long-lived AWS keys are never stored.
  'lambda-microvms': [],
  docker: [],
  kubernetes: [],
  host: [],
};

const inside = (dir, path) => {
  const rel = relative(resolve(dir), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export function credentialsDir(env = process.env) {
  const dir = env.MAXWELL_SANDBOX_CREDENTIALS_DIR || join(env.HOME || homedir(), '.config', 'maxwell', 'sandbox');
  if (inside(WORKSPACE, dir)) throw new ExecutorError('credentials-in-workspace', `sandbox credentials must be stored outside the workspace, not in ${dir}`);
  return dir;
}

export const credentialsFile = (provider, env = process.env) => join(credentialsDir(env), `${provider}.env`);

export function writeCredentials(provider, values, env = process.env) {
  const allowed = PROVIDER_CREDENTIALS[provider];
  if (!allowed) throw new ExecutorError('usage', `unknown provider ${provider}`);
  const names = Object.keys(values || {});
  const unknown = names.filter((n) => !allowed.includes(n));
  if (unknown.length) throw new ExecutorError('usage', `${provider} does not use ${unknown.join(', ')}; expected ${allowed.join(', ') || 'no credentials'}`);
  const merged = { ...readCredentials(provider, env), ...values };
  for (const [k, v] of Object.entries(merged)) {
    if (typeof v !== 'string' || !v.trim() || /[\r\n\0]/.test(v)) throw new ExecutorError('usage', `${k} must be a non-empty single-line string`);
  }
  const dir = credentialsDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = credentialsFile(provider, env);
  const body = ['# Maxwell sandbox credentials. Keep outside the workspace, mode 0600. Never commit.', ...Object.entries(merged).map(([k, v]) => `${k}=${JSON.stringify(v)}`), ''].join('\n');
  writeFileSync(file, body, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function readCredentials(provider, env = process.env) {
  const file = credentialsFile(provider, env);
  return existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
}

// Puts a provider's stored credentials into this process's environment (existing variables win) and reports which
// names are present, never the values.
export function applyCredentials(provider, env = process.env) {
  const needed = PROVIDER_CREDENTIALS[provider] || [];
  const stored = readCredentials(provider, env);
  for (const name of needed) if (!env[name] && stored[name]) env[name] = stored[name];
  return { needed, present: needed.filter((n) => Boolean(env[n])), missing: needed.filter((n) => !env[n]) };
}
