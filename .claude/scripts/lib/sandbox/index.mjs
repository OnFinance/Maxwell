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
import { ExecutorError, HOSTED, RUNTIME_PROVIDERS, limitsOf } from './common.mjs';

export const BACKENDS = { host, docker, kubernetes, e2b, daytona, modal, vercel };
export const EXECUTOR_SCHEMA = 'https://maxwell.onfinance.ai/schemas/v1/company/executor.schema.json';

export const executorPath = (companyId, root = '.') => join(root, 'company-profile', companyId, 'sdlc', 'executor.json');

export function loadExecutor(companyId, { root = '.' } = {}) {
  const path = executorPath(companyId, root);
  if (!existsSync(path)) return null;
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const check = getValidator(buildAjv().ajv, EXECUTOR_SCHEMA);
  if (!check(config)) throw new ExecutorError('invalid-config', `${path} does not match its schema:\n${formatErrors(check.errors)}`);
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
