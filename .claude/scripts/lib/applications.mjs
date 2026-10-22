// Builds the files for a new application (applications/<app_id>/) from a short JSON spec, validated before anything
// is written. Used by .claude/scripts/apps/add.mjs. Pure apart from schema loading: no filesystem writes here.
//
// Spec: { appId, description?, sopsRecipients?: [age1...], repos: [{ repoId, url, pinnedCommit, defaultBranch?, host?,
//         visibility?, ...any other repo.schema.json field }] }
// Repository facts Maxwell cannot know before it has looked (languages, build and CI system, IaC, Helm, agent code,
// CODEOWNERS) default to the schema's "not yet known" values (languages [], buildSystem/ciSystem "other", booleans
// false) unless the spec gives them; refresh-apps replaces them from the checkout. Each defaulted field is reported.
import { buildAjv, getValidator, formatErrors } from './schemas.mjs';
import { findSecret } from '../../hooks/lib.mjs';

export const REPO_SCHEMA = 'https://maxwell.onfinance.ai/schemas/v1/application/repo.schema.json';
export const CREDENTIALS_SCHEMA = 'https://maxwell.onfinance.ai/schemas/v1/application/credentials.schema.json';
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const FULL_SHA = /^[a-f0-9]{40}$/;
const SPEC_KEYS = new Set(['appId', 'description', 'sopsRecipients', 'repos']);
const AGENT = '.claude/scripts/apps/add.mjs';

const HOSTS = [[/(^|\.)github\.com$/, 'github'], [/(^|\.)gitlab\.com$/, 'gitlab'], [/(^|\.)bitbucket\.org$/, 'bitbucket'], [/(^|\.)(dev\.azure\.com|visualstudio\.com)$/, 'azure-devops']];

// Host name of a clone URL in https://, ssh:// or scp-like git@host:path form, or null.
export function urlHost(url) {
  const s = String(url || '');
  const m = /^(?:https|ssh):\/\/(?:[^@/]*@)?([^/:]+)/.exec(s) || /^[A-Za-z0-9._-]+@([^:/]+):/.exec(s);
  return m ? m[1].toLowerCase() : null;
}

export function hostOf(url) {
  const h = urlHost(url);
  if (!h) return 'other';
  for (const [re, name] of HOSTS) if (re.test(h)) return name;
  return 'other';
}

// An https:// URL with a user part carries a token far too often (https://<token>@host/...), so it is refused even
// though the repo schema allows a bare username. ssh:// and git@host:path keep their SSH user name.
export function urlProblem(url) {
  const s = String(url || '');
  if (/^https?:\/\/[^/]*@/i.test(s)) return 'https:// clone URLs must not contain a user name or token; authenticate through git\'s credential helper or an SSH key instead';
  if (/^http:\/\//i.test(s)) return 'use an https:// or ssh:// clone URL';
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
  lines.push('', 'Added with `node .claude/scripts/apps/add.mjs`. Languages, build and CI systems and the other repository facts', 'are filled in by `/refresh-apps` from the checkout.', '');
  return lines.join('\n');
}

// Returns { problems: string[], repos: [{ repoId, doc, defaulted: string[] }], credentials: doc|null, readme }.
// `now` is an RFC 3339 UTC timestamp; `checkedOut` maps repoId -> true when a checkout is fetched now, or to the earlier
// lastFetchedAt of a checkout that is kept as it is.
export function planApplication(spec, { now, env = process.env, recipients, checkedOut = {}, ajv = buildAjv().ajv } = {}) {
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
    for (const k of ['schemaVersion', 'kind', 'appId', 'provenance', 'localCheckout', 'lastFetchedAt']) if (k in r) problems.push(`${at}.${k} is set by the writer, not the spec`);
    const defaults = { host: hostOf(r.url), visibility: 'private', defaultBranch: 'main', languages: [], buildSystem: 'other', ciSystem: 'other', containsIac: false, containsHelmChart: false, containsAgentCode: false, codeownersPresent: false };
    const defaulted = Object.keys(defaults).filter((k) => !(k in r));
    const doc = {
      schemaVersion: '1', kind: 'maxwell.app.repo', appId: spec.appId, ...defaults, ...r,
      ...(checkedOut[r.repoId] ? { lastFetchedAt: typeof checkedOut[r.repoId] === 'string' ? checkedOut[r.repoId] : now, localCheckout: `applications/${spec.appId}/repos/${r.repoId}` } : {}),
      provenance: provenance(now, env),
    };
    if (!validateRepo(doc)) problems.push(`${at} (${r.repoId}) does not match repo.schema.json:\n${formatErrors(validateRepo.errors)}`);
    repos.push({ repoId: r.repoId, doc, defaulted });
  }
  let credentials = null;
  if (recipients !== null) {
    const list = recipients || spec.sopsRecipients || (env.SOPS_AGE_RECIPIENTS ? env.SOPS_AGE_RECIPIENTS.split(',').map((s) => s.trim()).filter(Boolean) : []);
    credentials = { schemaVersion: '1', kind: 'maxwell.app.credentials', appId: spec.appId, entries: [], sopsRecipients: list, provenance: provenance(now, env) };
    const validateCreds = getValidator(ajv, CREDENTIALS_SCHEMA);
    if (!list.length) problems.push('credentials.json needs at least one age recipient (public key): set sopsRecipients in the spec or SOPS_AGE_RECIPIENTS');
    else if (!validateCreds(credentials)) problems.push(`credentials.json would not match its schema:\n${formatErrors(validateCreds.errors)}`);
  }
  return { problems, repos, credentials, readme: SLUG.test(spec.appId || '') && Array.isArray(spec.repos) ? readme(spec) : '' };
}
