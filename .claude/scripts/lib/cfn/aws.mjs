// Every AWS CLI call cfn-verify makes goes through here, in one of two modes:
//   emulator  a local AWS emulator (moto or LocalStack) on loopback: anything may be called (create-stack and
//             delete-stack included), with throwaway credentials ("test") and the endpoint given explicitly on every
//             call. The endpoint must be http(s) on a loopback address, and a name must resolve to loopback only:
//             a misconfigured endpoint never sends create-stack to real AWS (and "test" credentials would be refused
//             there anyway).
//   aws       the company's real AWS account, read-only: only the calls READ_ONLY lists (validate-template, describes,
//             drift detection, STS identity and assume-role), never one whose name starts like a change (create,
//             update, delete, execute, put, ...), no endpoint override, no profile, no file the CLI could read
//             credentials from but the ones given.
import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class AwsPolicyError extends Error {
  constructor(message) { super(message); this.code = 'aws-policy'; }
}

/** Read-only calls allowed against real AWS: service -> operations. */
export const READ_ONLY = Object.freeze({
  sts: ['get-caller-identity', 'assume-role'],
  cloudformation: ['validate-template', 'describe-stacks', 'describe-stack-resources', 'describe-stack-events', 'get-template-summary',
    'detect-stack-drift', 'describe-stack-drift-detection-status', 'describe-stack-resource-drifts'],
});
/** An operation whose name starts like a change is refused against real AWS whatever READ_ONLY says. */
export const MUTATING = /^(create|update|delete|execute|put|set|tag|untag|cancel|continue|signal|rollback|import|activate|deactivate|register|deregister|publish|record|stop|start|attach|detach|associate|disassociate|modify|reset|restore|enable|disable|add|remove|upload|replace|run|terminate|deploy|package)-/;
const NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
const FORBIDDEN_ARGS = /^--(endpoint-url|profile|ca-bundle|no-verify-ssl|cli-input-json|cli-input-yaml|debug)(=|$)/;

const loopbackAddress = (a) => (isIP(a) === 4 && a.startsWith('127.')) || (isIP(a) === 6 && (a === '::1' || a === '0:0:0:0:0:0:0:1'));

/**
 * The emulator's endpoint, checked: http(s), no credentials in it, its host a loopback address or a name that resolves
 * to loopback addresses only. Throws AwsPolicyError otherwise (a real AWS endpoint, an internal address, a name that
 * also resolves elsewhere).
 */
export async function loopbackEndpoint(raw, { resolve = (h) => lookup(h, { all: true }) } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new AwsPolicyError(`the emulator endpoint ${raw} is not a URL`); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || (u.pathname && u.pathname !== '/'))
    throw new AwsPolicyError(`the emulator endpoint ${raw} must be http(s)://<loopback>:<port> and nothing else`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (isIP(host)) addrs = [host];
  else {
    try { addrs = (await resolve(host)).map((a) => a.address); } catch { throw new AwsPolicyError(`the emulator endpoint's host ${host} does not resolve`); }
  }
  if (!addrs.length || !addrs.every(loopbackAddress))
    throw new AwsPolicyError(`refused: the emulator endpoint ${raw} is not on loopback (${addrs.join(', ') || 'no address'}): create-stack and delete-stack go only to a local emulator`);
  return `${u.protocol}//${isIP(host) === 6 ? `[${host}]` : host}${u.port ? `:${u.port}` : ''}`;
}

/** Throws AwsPolicyError when `service op args` may not be called in `ctx` (see the header). */
export function checkAwsCall(ctx, service, op, args = []) {
  if (!NAME.test(service) || !NAME.test(op)) throw new AwsPolicyError(`not an AWS CLI service and operation: ${service} ${op}`);
  for (const a of args) if (typeof a !== 'string' || FORBIDDEN_ARGS.test(a)) throw new AwsPolicyError(`the argument ${String(a).slice(0, 40)} is not allowed`);
  if (ctx.mode === 'emulator') {
    if (typeof ctx.endpoint !== 'string' || !ctx.checked) throw new AwsPolicyError('the emulator endpoint was not checked for loopback');
    const host = new URL(ctx.endpoint).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !loopbackAddress(host)) throw new AwsPolicyError(`refused: ${ctx.endpoint} is not on loopback`);
    return;
  }
  if (ctx.mode !== 'aws') throw new AwsPolicyError(`unknown AWS mode ${ctx.mode}`);
  if (MUTATING.test(op)) throw new AwsPolicyError(`refused: ${service} ${op} changes AWS resources; Maxwell only reads a company's AWS account`);
  if (!(READ_ONLY[service] || []).includes(op)) throw new AwsPolicyError(`refused: ${service} ${op} is not one of the read-only calls Maxwell makes against AWS`);
}

/** An emulator context: the endpoint checked for loopback, throwaway credentials. */
export async function emulatorContext(endpoint, opts = {}) {
  return { mode: 'emulator', endpoint: await loopbackEndpoint(endpoint, opts), checked: true, region: opts.region || 'us-east-1' };
}

/** A real-AWS read-only context from credentials (never logged, never written). */
export function awsContext(creds, region) {
  if (!creds || !creds.accessKeyId || !creds.secretAccessKey) throw new AwsPolicyError('no AWS read-only credentials');
  return { mode: 'aws', creds, region: region || 'us-east-1' };
}

/** The CLI's environment for a context: only what it needs; for the emulator, never a real credential or proxy. */
export function awsEnv(ctx, base = process.env, home) {
  const env = { PATH: base.PATH || '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', AWS_PAGER: '', AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_EC2_METADATA_DISABLED: 'true', AWS_DEFAULT_REGION: ctx.region, AWS_REGION: ctx.region, AWS_RETRY_MODE: 'standard', AWS_MAX_ATTEMPTS: '2' };
  if (ctx.mode === 'emulator') {
    Object.assign(env, { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_ENDPOINT_URL: ctx.endpoint, NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1' });
  } else {
    Object.assign(env, { AWS_ACCESS_KEY_ID: ctx.creds.accessKeyId, AWS_SECRET_ACCESS_KEY: ctx.creds.secretAccessKey, ...(ctx.creds.sessionToken ? { AWS_SESSION_TOKEN: ctx.creds.sessionToken } : {}) });
    // Real AWS goes through the run's own egress proxy, as every other host.
    for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'AWS_CA_BUNDLE']) if (base[k]) env[k] = base[k];
  }
  return env;
}

/**
 * Runs `aws <service> <op> <args>` in `ctx` after checkAwsCall; JSON output parsed. Returns { ok, status, json, stderr }.
 * `run` is spawnSync (tests give a stand-in). Secrets never reach the arguments.
 */
export function awsCall(ctx, service, op, args, { bin = 'aws', home, run = spawnSync, timeoutMs = 120000, base = process.env } = {}) {
  checkAwsCall(ctx, service, op, args);
  const argv = [...(ctx.mode === 'emulator' ? ['--endpoint-url', ctx.endpoint] : []), '--region', ctx.region, '--output', 'json', '--no-cli-pager', service, op, ...args];
  const r = run(bin, argv, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20, env: awsEnv(ctx, base, home) });
  let json = null;
  try { json = r.stdout && r.stdout.trim() ? JSON.parse(r.stdout) : null; } catch { json = null; }
  return { ok: r.status === 0, status: r.status, json, stdout: r.stdout || '', stderr: String(r.stderr || '').trim().slice(-2000) };
}
