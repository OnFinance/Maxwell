// Executor selection: company-profile/<company_id>/sdlc/executor.json decides where pinned scanners (static) and
// read-only runtime commands (runtime) run; this module loads it and dispatches to the backend.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAjv, getValidator, formatErrors } from '../schemas.mjs';
import * as host from './backends/host.mjs';
import * as docker from './backends/docker.mjs';
import * as kubernetes from './backends/kubernetes.mjs';
import * as e2b from './backends/e2b.mjs';
import * as daytona from './backends/daytona.mjs';
import * as modal from './backends/modal.mjs';
import * as vercel from './backends/vercel.mjs';
import * as lambdaMicrovms from './backends/lambda-microvms.mjs';
import { ExecutorError, HOSTED, RUNTIME_PROVIDERS, limitsOf, residencyProblem } from './common.mjs';
import { hostSetting } from '../config.mjs';

export const BACKENDS = { host, docker, kubernetes, e2b, daytona, modal, vercel, 'lambda-microvms': lambdaMicrovms };
export const EXECUTOR_SCHEMA = 'https://maxwell.onfinance.ai/schemas/v1/company/executor.schema.json';

export const executorPath = (companyId, root = '.') => join(root, 'company-profile', companyId, 'sdlc', 'executor.json');

// Where the executor for a company comes from: the host setting executor.file (MAXWELL_EXECUTOR_FILE, or the host config
// file) when set, so a hosted harness can supply it without writing into the workspace; else the company's own file.
export function executorSource(companyId, { root = '.', env = process.env } = {}) {
  const override = hostSetting('executor.file', env);
  if (override.value) return { path: override.value, override: true, source: override.source };
  return { path: executorPath(companyId, root), override: false, source: 'company' };
}

export function loadExecutor(companyId, { root = '.', env = process.env } = {}) {
  const { path, override } = executorSource(companyId, { root, env });
  if (!existsSync(path)) {
    if (override) throw new ExecutorError('invalid-config', `executor.file points to ${path}, which does not exist`);
    return null;
  }
  let config;
  // A company's own file reads exactly as before; for a file from outside the workspace the parser's message, which
  // quotes file text, is never passed on.
  if (!override) config = JSON.parse(readFileSync(path, 'utf8'));
  else try { config = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new ExecutorError('invalid-config', `${path} is not valid JSON`); }
  const check = getValidator(buildAjv().ajv, EXECUTOR_SCHEMA);
  if (!check(config)) throw new ExecutorError('invalid-config', `${path} does not match its schema:\n${formatErrors(check.errors)}`);
  if (override) {
    // One executor.file serves one company: a host running several companies keeps theirs in each company's folder.
    if (config.companyId !== companyId) throw new ExecutorError('invalid-config', `${path} is for company ${config.companyId}, not ${companyId}`);
    // A file from outside never went through /connect-sandbox, so its data-residency rule is applied here.
    const detailsPath = join(root, 'company-profile', companyId, 'details.json');
    const problem = existsSync(detailsPath) ? residencyProblem(config, JSON.parse(readFileSync(detailsPath, 'utf8'))) : null;
    if (problem) throw new ExecutorError('invalid-config', `${path}: ${problem}; use an Indian region in that file, or clear executor.file and set the executor with /connect-sandbox, which can record that the user accepts scanning outside India`);
  }
  return config;
}

export function staticExecutor(config) {
  const provider = config && config.static && config.static.provider;
  if (!provider || provider === 'none') throw new ExecutorError('no-executor', 'no scanner executor is configured; run /connect-sandbox (probes fall back to manual review until then)');
  const providerConfig = (config.providers && config.providers[provider]) || {};
  const network = HOSTED.includes(provider) || provider !== 'host' ? (config.static.network || 'none') : 'host';
  return { provider, providerConfig, network, region: config.static.region, limits: limitsOf(config.static) };
}

export function runtimeExecutor(config) {
  const provider = config && config.runtime && config.runtime.provider;
  if (!provider || provider === 'none') throw new ExecutorError('no-executor', 'no runtime executor is configured; runtime probes stay plan-only (as with --dry-run) until /connect-sandbox sets one');
  if (!RUNTIME_PROVIDERS.includes(provider)) throw new ExecutorError('invalid-config', `runtime probes cannot run on ${provider}: target credentials never go to a hosted sandbox`);
  return { provider, providerConfig: (config.providers && config.providers[provider]) || {}, timeoutSeconds: (config.runtime && config.runtime.timeoutSeconds) || 60 };
}

export async function runStaticTool(config, job, deps = {}) {
  const ex = staticExecutor(config);
  return BACKENDS[ex.provider].runTool({ ...job, network: ex.network, limits: ex.limits, region: ex.region, providerConfig: ex.providerConfig, deps });
}

export async function runRuntimeCommand(config, job, deps = {}) {
  const ex = runtimeExecutor(config);
  return BACKENDS[ex.provider].runCommand({ ...job, timeoutSeconds: Math.min(job.timeoutSeconds || ex.timeoutSeconds, ex.timeoutSeconds), providerConfig: ex.providerConfig, deps });
}
