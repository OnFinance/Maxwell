// Preconditions and credential handling for runtime probe commands, from runtime-probe-rules-of-engagement
// sections 1 to 3. Pure functions; sandbox/exec.mjs supplies the clock, files and environment.
import { isAbsolute, relative, resolve } from 'node:path';
import { ExecutorError } from './common.mjs';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const minutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// allowedWindows absent or empty means any time. startUtc == endUtc is the whole day; endUtc < startUtc wraps past
// midnight, so a Friday 22:00-02:00 window also covers early Saturday.
export function inWindows(windows, at) {
  if (!Array.isArray(windows) || !windows.length) return true;
  const day = DAYS[at.getUTCDay()];
  const prev = DAYS[(at.getUTCDay() + 6) % 7];
  const t = at.getUTCHours() * 60 + at.getUTCMinutes();
  return windows.some((w) => {
    const s = minutes(w.startUtc); const e = minutes(w.endUtc);
    if (s === e) return w.daysOfWeek.includes(day);
    if (s < e) return w.daysOfWeek.includes(day) && t >= s && t < e;
    return (w.daysOfWeek.includes(day) && t >= s) || (w.daysOfWeek.includes(prev) && t < e);
  });
}

export function activeFreeze(freezes, at) {
  return (freezes || []).find((f) => Date.parse(f.from) <= at.getTime() && at.getTime() < Date.parse(f.to)) || null;
}

// Every failed check, not just the first (section 1). Freezes are evaluated before windows.
export function environmentBlockers(env, at) {
  const blockers = [];
  const access = env.probeAccess || {};
  if (access.readOnly !== true) blockers.push('probeAccess.readOnly is not true');
  if (!access.method || access.method === 'none') blockers.push('probeAccess.method is none: evidence is requested from humans, no command runs');
  const freeze = activeFreeze(env.changeFreeze, at);
  if (freeze) blockers.push(`change freeze until ${freeze.to}: ${freeze.reason}`);
  if (!inWindows(access.allowedWindows, at)) blockers.push(`outside probeAccess.allowedWindows at ${at.toISOString().replace(/\.\d{3}Z$/, 'Z')}`);
  if (['kubeconfig', 'ssh', 'docker-socket', 'cloud-api'].includes(access.method) && !access.credentialKey) blockers.push(`probeAccess.method ${access.method} needs a credentialKey`);
  return blockers;
}

// At most `limit` commands in any rolling minute; prod and dr never exceed 60 (section 1).
export function rateLimit(timestamps, { limit, tier, at }) {
  const cap = ['prod', 'dr'].includes(tier) ? Math.min(limit || 30, 60) : (limit || 30);
  const recent = (timestamps || []).filter((t) => at - t < 60000).sort((a, b) => a - b);
  if (recent.length < cap) return { ok: true, waitMs: 0, timestamps: [...recent, at], cap };
  return { ok: false, waitMs: 60000 - (at - recent[recent.length - cap]) + 50, timestamps: recent, cap };
}

const inside = (dir, path) => {
  const rel = relative(resolve(dir), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

// Resolves a locator from `creds/sops.mjs get` without printing it. env: the variable named by ref holds the value
// (usually a path); file: ref is an absolute path outside the workspace. Other locator providers are resolved by the
// operator's secret manager into an environment variable, so they count as missing access here (section 8).
export function resolveLocator(entry, { envId, workspace, env = process.env }) {
  if (!entry || typeof entry !== 'object') throw new ExecutorError('missing-access', 'no credential entry');
  if (entry.scope !== 'read-only') throw new ExecutorError('missing-access', `credential ${entry.key} has scope ${entry.scope}; probes need read-only`);
  if (!Array.isArray(entry.envIds) || !entry.envIds.includes(envId)) throw new ExecutorError('missing-access', `credential ${entry.key} is not granted for environment ${envId}`);
  if (entry.provider === 'env') {
    const value = env[entry.ref];
    if (!value) throw new ExecutorError('missing-access', `${entry.ref} is not set on this host`);
    return value;
  }
  if (entry.provider === 'file') {
    if (!isAbsolute(entry.ref) || inside(workspace, entry.ref)) throw new ExecutorError('missing-access', 'a file locator must be an absolute path outside the workspace');
    return entry.ref;
  }
  throw new ExecutorError('missing-access', `${entry.provider} locators are not fetched by Maxwell; have your secret manager export the credential into an environment variable and record it with provider env`);
}

const DOCKER_RAW = /^unix:\/\/.*docker\.sock$|:(2375|2376)\/?$/;

// Turns a resolved credential into environment variables and files for the chosen executor. Container executors
// receive file contents mounted under /run/maxwell; the host receives paths. Values never become arguments.
export function credentialMaterial({ method, binary, value, executor, readFile }) {
  const host = executor === 'host';
  const file = (name, envName, extraEnv = {}) => (host ? { env: { [envName]: value, ...extraEnv }, files: {} } : { env: { [envName]: `/run/maxwell/${name}`, ...extraEnv }, files: { [name]: readFile(value) } });
  if (method === 'kubeconfig') return file('kubeconfig', 'KUBECONFIG');
  if (method === 'docker-socket') {
    if (!/^(tcp|https?|unix):\/\//.test(value) || DOCKER_RAW.test(value)) throw new ExecutorError('refused', 'DOCKER_HOST must point at a read-only socket proxy, not the raw daemon socket or ports 2375/2376 (rules of engagement section 2)');
    return { env: { DOCKER_HOST: value }, files: {} };
  }
  if (method === 'cloud-api') {
    if (binary === 'aws') return isAbsolute(value) ? file('aws-credentials', 'AWS_SHARED_CREDENTIALS_FILE', { AWS_CONFIG_FILE: '/dev/null' }) : host ? { env: { AWS_PROFILE: value }, files: {} } : (() => { throw new ExecutorError('missing-access', 'in a container, the aws credential must be a path to a read-only shared credentials file'); })();
    if (binary === 'gcloud') return file('gcloud-key.json', 'CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE', host ? {} : { CLOUDSDK_CONFIG: '/tmp/gcloud' });
    if (binary === 'az') {
      if (!host) throw new ExecutorError('missing-access', 'az keeps its login in a config directory, so it runs only on the host executor');
      return { env: { AZURE_CONFIG_DIR: value }, files: {} };
    }
    return { env: {}, files: {} };
  }
  return { env: {}, files: {} };
}

// jq, grep and head -c over the previous stage's output. grep uses JavaScript regular expressions.
export function grepStage(argv, input) {
  let invert = false; let ignore = false; let only = false; let count = false; let fixed = false; let pattern;
  for (let i = 1; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '-e') { pattern = argv[i + 1]; i += 1; continue; }
    if (/^-[ivocEF]+$/.test(t)) { for (const ch of t.slice(1)) { if (ch === 'v') invert = true; if (ch === 'i') ignore = true; if (ch === 'o') only = true; if (ch === 'c') count = true; if (ch === 'F') fixed = true; } continue; }
    if (t.startsWith('-')) throw new ExecutorError('refused', `grep ${t} is not supported`);
    pattern = t;
  }
  if (pattern === undefined) throw new ExecutorError('refused', 'grep needs a pattern');
  const re = new RegExp(fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, ignore ? 'gi' : 'g');
  const lines = String(input).split('\n');
  if (input.endsWith('\n')) lines.pop();
  const hits = [];
  for (const line of lines) {
    re.lastIndex = 0;
    const matched = re.test(line);
    if (matched === invert) continue;
    if (only && !invert) { re.lastIndex = 0; hits.push(...(line.match(re) || [])); } else hits.push(line);
  }
  return count ? `${hits.length}\n` : hits.length ? `${hits.join('\n')}\n` : '';
}

export function headStage(argv, input) {
  return Buffer.from(String(input)).subarray(0, Number(argv[2])).toString('utf8');
}
