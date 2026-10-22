// Builds the files for a new application (applications/<app_id>/) from a short JSON spec, validated before anything
// is written. Used by .claude/scripts/apps/add.mjs. Apart from schema loading and deriveFacts (which reads a checkout),
// nothing here touches the filesystem.
//
// Spec: { appId, description?, sopsRecipients?: [age1...], repos: [{ repoId, url, pinnedCommit, defaultBranch?, host?,
//         visibility?, ...any other repo.schema.json field }] }
// Each repo manifest is layered: schema "not yet known" values < the previous manifest (when updating) < facts read
// from a fresh checkout < fields the spec gives. Fields that are still schema defaults are reported as `unverified`:
// probes select targets from them (containsIac, containsHelmChart, containsAgentCode), so /refresh-apps must run
// before any probe to replace them from the checkout.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildAjv, getValidator, formatErrors } from './schemas.mjs';
import { findSecret } from '../../hooks/lib.mjs';

export const REPO_SCHEMA = 'https://maxwell.onfinance.ai/schemas/v1/application/repo.schema.json';
export const CREDENTIALS_SCHEMA = 'https://maxwell.onfinance.ai/schemas/v1/application/credentials.schema.json';
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const FULL_SHA = /^[a-f0-9]{40}$/;
const SPEC_KEYS = new Set(['appId', 'description', 'sopsRecipients', 'repos']);
const WRITER_KEYS = ['schemaVersion', 'kind', 'appId', 'provenance', 'localCheckout', 'lastFetchedAt'];
const AGENT = '.claude/scripts/apps/add.mjs';

const HOSTS = [[/(^|\.)github\.com$/, 'github'], [/(^|\.)gitlab\.com$/, 'gitlab'], [/(^|\.)bitbucket\.org$/, 'bitbucket'], [/(^|\.)(dev\.azure\.com|visualstudio\.com)$/, 'azure-devops']];

// User and host of a clone URL in https://, ssh:// or scp-like user@host:path form, or null.
export function urlParts(url) {
  const s = String(url || '');
  const m = /^(?:https|ssh):\/\/(?:([^@/]*)@)?([^/:]+)/.exec(s) || /^([A-Za-z0-9._-]+)@([^:/]+):/.exec(s);
  return m ? { user: m[1] === undefined ? null : m[1], host: m[2].toLowerCase() } : null;
}

export const urlHost = (url) => (urlParts(url) || {}).host || null;

export function hostOf(url) {
  const h = urlHost(url);
  if (!h) return 'other';
  for (const [re, name] of HOSTS) if (re.test(h)) return name;
  return 'other';
}

// An https:// URL with a user part carries a token far too often (https://<token>@host/...), so it is refused even
// though the repo schema allows a bare username. ssh:// and user@host:path may name only the conventional "git" user.
export function urlProblem(url) {
  const s = String(url || '');
  if (/^https?:\/\/[^/]*@/i.test(s)) return 'https:// clone URLs must not contain a user name or token; authenticate through git\'s credential helper or an SSH key instead';
  if (/^http:\/\//i.test(s)) return 'use an https:// or ssh:// clone URL';
  const parts = urlParts(s);
  if (parts && parts.host.startsWith('-')) return 'the clone URL host must not start with "-"';
  if (parts && parts.user !== null && parts.user !== 'git') return 'SSH clone URLs may only use the "git" user';
  if (findSecret(s)) return 'the clone URL looks like it contains a secret';
  return null;
}

export function provenance(now, env = process.env) {
  return { harness: 'script', generatedAt: now, ...(env.MAXWELL_RUN_ID && /^run_[0-9A-HJKMNP-TV-Z]{26}$/.test(env.MAXWELL_RUN_ID) ? { runId: env.MAXWELL_RUN_ID } : {}), agent: AGENT };
}

export function readme(spec) {
  const lines = [`# ${spec.appId}`, ''];
  if (spec.description) lines.push(String(spec.description).trim(), '');
  lines.push('Repositories:', '');
  for (const r of spec.repos) lines.push(`- \`${r.repoId}\`: ${r.url} at \`${r.pinnedCommit}\``);
  lines.push('', 'Added with `node .claude/scripts/apps/add.mjs`. Run `/refresh-apps` before any probe: it fills in languages, build', 'and CI systems and the other repository facts from the checkout.', '');
  return lines.join('\n');
}

// Reads the facts probes select targets by from a checkout's file names (and, for CloudFormation and agent
// dependencies, a few small files). Bounded: at most `limit` entries are visited; .git and vendored trees are skipped.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', '.venv', 'venv', 'dist', 'build', '.terraform']);
const AGENT_DEPS = /"(?:@modelcontextprotocol\/sdk|@anthropic-ai\/[a-z-]+|openai|langchain|@langchain\/[a-z-]+|@ai-sdk\/[a-z-]+)"\s*:|^\s*"?(?:anthropic|openai|langchain|langgraph|crewai|autogen|pyautogen|mcp|claude-agent-sdk|semantic-kernel)\b/m;
export function deriveFacts(dir, { limit = 50000 } = {}) {
  const facts = { containsIac: false, containsHelmChart: false, containsAgentCode: false, codeownersPresent: false };
  const small = (p) => { try { return statSync(p).size <= 256 * 1024 ? readFileSync(p, 'utf8') : ''; } catch { return ''; } };
  let seen = 0;
  const walk = (abs, rel) => {
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > limit) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = join(abs, e.name);
      if (e.isDirectory()) {
        if (e.name === '.claude' || e.name === '.agents') facts.containsAgentCode = true;
        if (!SKIP_DIRS.has(e.name)) walk(p, r);
        continue;
      }
      if (!e.isFile()) continue;
      const n = e.name;
      if (/\.(tf|tfvars|tf\.json)$/.test(n) || /^Pulumi\.ya?ml$/.test(n) || n === 'cdk.json' || n === 'ansible.cfg' || /\.cfn\.(ya?ml|json)$/.test(n)) facts.containsIac = true;
      else if (!facts.containsIac && /\.(ya?ml|json|template)$/.test(n) && /AWSTemplateFormatVersion/.test(small(p))) facts.containsIac = true;
      if (n === 'Chart.yaml' || /^kustomization\.ya?ml$/.test(n)) facts.containsHelmChart = true;
      if (/^(CODEOWNERS|\.github\/CODEOWNERS|docs\/CODEOWNERS|\.gitlab\/CODEOWNERS)$/.test(r)) facts.codeownersPresent = true;
      if (/^(CLAUDE\.md|AGENTS\.md|opencode\.jsonc?|\.mcp\.json|mcp\.json)$/.test(n)) facts.containsAgentCode = true;
      else if (!facts.containsAgentCode && /^(package\.json|requirements[\w.-]*\.txt|pyproject\.toml)$/.test(n) && AGENT_DEPS.test(small(p))) facts.containsAgentCode = true;
    }
  };
  walk(dir, '');
  return facts;
}

// Returns { problems: string[], repos: [{ repoId, doc, unverified: string[] }], credentials: doc|null, readme }.
// `now` is an RFC 3339 UTC timestamp; `checkedOut` maps repoId -> true when a checkout is fetched now, or to the earlier
// lastFetchedAt of a checkout that is kept as it is; `previous` maps repoId -> the manifest being updated; `facts` maps
// repoId -> fields read from a fresh checkout. `recipients: null` means credentials.json exists and is left alone.
export function planApplication(spec, { now, env = process.env, recipients, checkedOut = {}, previous = {}, facts = {}, ajv = buildAjv().ajv } = {}) {
  const problems = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { problems: ['the spec must be a JSON object'], repos: [], credentials: null, readme: '' };
  for (const k of Object.keys(spec)) if (!SPEC_KEYS.has(k)) problems.push(`unknown spec key '${k}' (expected ${[...SPEC_KEYS].join(', ')})`);
  if (!SLUG.test(spec.appId || '')) problems.push(`appId must be a slug (lower-case letters, digits and dashes, 2-63 characters): ${JSON.stringify(spec.appId)}`);
  if (spec.description !== undefined && typeof spec.description !== 'string') problems.push('description must be a string');
  if (typeof spec.description === 'string' && findSecret(spec.description)) problems.push(`description contains something that looks like a secret (${findSecret(spec.description)})`);
  if (!Array.isArray(spec.repos) || spec.repos.length === 0) problems.push('repos must list at least one repository');
  const validateRepo = getValidator(ajv, REPO_SCHEMA);
  const seen = new Set();
  const repos = [];
  for (const [i, r] of (Array.isArray(spec.repos) ? spec.repos : []).entries()) {
    const at = `repos[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) { problems.push(`${at} must be an object`); continue; }
    if (!SLUG.test(r.repoId || '')) { problems.push(`${at}.repoId must be a slug: ${JSON.stringify(r.repoId)}`); continue; }
    if (seen.has(r.repoId)) problems.push(`${at}.repoId ${r.repoId} is listed twice`);
    seen.add(r.repoId);
    if (!FULL_SHA.test(r.pinnedCommit || '')) problems.push(`${at}.pinnedCommit must be a full 40-character commit SHA`);
    const urlBad = urlProblem(r.url);
    if (urlBad) problems.push(`${at}.url: ${urlBad}`);
    for (const k of WRITER_KEYS) if (k in r) problems.push(`${at}.${k} is set by the writer, not the spec`);
    const defaults = { host: hostOf(r.url), visibility: 'private', defaultBranch: 'main', languages: [], buildSystem: 'other', ciSystem: 'other', containsIac: false, containsHelmChart: false, containsAgentCode: false, codeownersPresent: false };
    const prev = Object.fromEntries(Object.entries(previous[r.repoId] || {}).filter(([k]) => !WRITER_KEYS.includes(k)));
    const found = facts[r.repoId] || {};
    const unverified = Object.keys(defaults).filter((k) => k !== 'host' && !(k in prev) && !(k in found) && !(k in r));
    const kept = checkedOut[r.repoId];
    const doc = {
      schemaVersion: '1', kind: 'maxwell.app.repo', appId: spec.appId, ...defaults, ...prev, ...found, ...r,
      ...(kept ? { lastFetchedAt: typeof kept === 'string' ? kept : now, localCheckout: `applications/${spec.appId}/repos/${r.repoId}` } : {}),
      provenance: provenance(now, env),
    };
    if (!validateRepo(doc)) problems.push(`${at} (${r.repoId}) does not match repo.schema.json:\n${formatErrors(validateRepo.errors)}`);
    repos.push({ repoId: r.repoId, doc, unverified });
  }
  let credentials = null;
  if (recipients !== null) {
    // Same order as creds/sops.mjs: SOPS_AGE_RECIPIENTS first, then the document's own list.
    const fromEnv = env.SOPS_AGE_RECIPIENTS ? env.SOPS_AGE_RECIPIENTS.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const list = recipients || (fromEnv.length ? fromEnv : spec.sopsRecipients || []);
    credentials = { schemaVersion: '1', kind: 'maxwell.app.credentials', appId: spec.appId, entries: [], sopsRecipients: list, provenance: provenance(now, env) };
    const validateCreds = getValidator(ajv, CREDENTIALS_SCHEMA);
    if (!list.length) problems.push('credentials.json needs at least one age recipient (public key): set SOPS_AGE_RECIPIENTS or sopsRecipients in the spec');
    else if (!validateCreds(credentials)) problems.push(`credentials.json would not match its schema:\n${formatErrors(validateCreds.errors)}`);
  }
  return { problems, repos, credentials, readme: SLUG.test(spec.appId || '') && Array.isArray(spec.repos) ? readme(spec) : '' };
}

// JSON.parse messages can quote the input; report only where the error is.
export function jsonErrorWhere(text, err) {
  const m = /position (\d+)/.exec(String(err && err.message));
  if (!m) return 'invalid JSON';
  const before = String(text).slice(0, Number(m[1]));
  return `invalid JSON at line ${before.split('\n').length}, column ${before.length - before.lastIndexOf('\n')}`;
}
