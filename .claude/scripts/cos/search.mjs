#!/usr/bin/env node
// ComplianceOS search: Maxwell's first source for regulator circulars, directions, clauses and requirements.
//   search --query <text> [--collection regulatory_communication] [--in <field>] [--regulator RBI,SEBI]
//          [--doc-type <t>] [--circular <regulatory_communication id>] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//          [--top-k 10] [--offset 0] [--rerank] [--latest-version] [--fields a,b]
//          [--full-text [--max-chars 20000]] [--raw] [--keep-unmatched] [--include-email]
//   status                      configured? token cached? (no network, never prints secrets)
//   set-credentials [--no-verify]   read {"email","password"[,"baseUrl"]} JSON on stdin, store it outside the
//                               workspace (mode 0600) and verify it with a login
//   login | logout              force a fresh token | drop the cached token
// Hits that do not contain the query terms, email-ingested items and duplicates are dropped (counted in
// "dropped"); regulator names are inferred from circular numbers and titles.
// Exit codes: 0 ok, 2 usage, 3 not configured, 4 login rejected or CAPTCHA required, 5 unreachable or rate
// limited. Errors are one JSON object on stderr with a "fallback" instruction: public web search.
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COLLECTIONS, ComplianceOsError, configPaths, createClient, formatEnvFile, isInside, maskEmail,
  normaliseResults, resolveCredentials,
} from '../lib/complianceos.mjs';

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXIT = { usage: 2, 'not-configured': 3, 'auth-failed': 4, 'captcha-required': 4, unreachable: 5, 'rate-limited': 5 };
const FALLBACK = 'Fall back to public WebSearch/WebFetch for this lookup (official regulator sites first) and say in the evidence that ComplianceOS was not used.';
const DEFAULT_MAX_CHARS = 20000;
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const isoFromEpoch = (s) => (s ? new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : undefined);

function fail(code, message) {
  const out = { error: code, message };
  if (code === 'not-configured') {
    out.action = 'Interactive session: ask the user in chat for their ComplianceOS email and password, then pipe {"email","password"} as JSON into `node .claude/scripts/cos/search.mjs set-credentials`. Headless run: do not wait for a human.';
  }
  if (code !== 'usage') out.fallback = FALLBACK;
  process.stderr.write(JSON.stringify(out) + '\n');
  process.exit(EXIT[code] || 1);
}

const paths = configPaths();
for (const [what, p] of Object.entries(paths)) {
  if (isInside(WORKSPACE, p)) fail('usage', `the ComplianceOS ${what} file ${p} is inside the workspace; keep it outside (default under ~/.config and ~/.cache)`);
}

const readText = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined);
const writePrivate = (p, content) => {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, content, { mode: 0o600 });
  chmodSync(p, 0o600);
};
const tokenStore = {
  read() { try { return JSON.parse(readText(paths.token) || 'null') || undefined; } catch { return undefined; } },
  write(entry) { writePrivate(paths.token, JSON.stringify(entry) + '\n'); },
  clear() { rmSync(paths.token, { force: true }); },
};

const [cmd, ...rest] = process.argv.slice(2);
let parsed;
try {
  parsed = parseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      query: { type: 'string', short: 'q' }, collection: { type: 'string' }, in: { type: 'string' },
      regulator: { type: 'string', multiple: true }, 'doc-type': { type: 'string', multiple: true },
      circular: { type: 'string', multiple: true },
      from: { type: 'string' }, to: { type: 'string' }, 'top-k': { type: 'string' }, offset: { type: 'string' },
      rerank: { type: 'boolean' }, 'no-rerank': { type: 'boolean' }, 'latest-version': { type: 'boolean' }, fields: { type: 'string' },
      'full-text': { type: 'boolean' }, 'max-chars': { type: 'string' }, raw: { type: 'boolean' },
      'keep-unmatched': { type: 'boolean' }, 'include-email': { type: 'boolean' }, 'no-verify': { type: 'boolean' },
    },
  });
} catch (err) { fail('usage', err.message); }
const flags = parsed.values;
const creds = () => resolveCredentials(process.env, readText(paths.credentials));
const clientFor = (c) => createClient({ ...c, tokenStore });

async function main() {
  switch (cmd) {
    case 'status': {
      const c = creds();
      const cached = tokenStore.read();
      const tokenValid = Boolean(cached && cached.baseUrl === c.baseUrl && cached.email === c.email && cached.expiresAt * 1000 > Date.now());
      console.log(JSON.stringify({
        configured: Boolean((c.email && c.password) || c.token), source: c.source, baseUrl: c.baseUrl, email: maskEmail(c.email),
        credentialsFile: existsSync(paths.credentials) ? paths.credentials : null, tokenCached: tokenValid,
        tokenValidUntil: tokenValid ? isoFromEpoch(cached.expiresAt) : undefined,
      }, null, 2));
      return;
    }
    case 'set-credentials': {
      if (process.stdin.isTTY) fail('usage', 'pipe {"email","password"} JSON on stdin; nothing is read from arguments so the password stays out of the process list');
      let input;
      try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { fail('usage', 'stdin is not a JSON object'); }
      const email = typeof input.email === 'string' ? input.email.trim() : '';
      const password = typeof input.password === 'string' ? input.password : '';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('usage', 'email is missing or not an email address');
      if (!password) fail('usage', 'password is missing');
      const baseUrl = (typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl.trim() : creds().baseUrl).replace(/\/+$/, '');
      if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(baseUrl)) fail('usage', 'baseUrl must be an https origin such as https://complianceos-prod.onfinance.ai');
      writePrivate(paths.credentials, formatEnvFile({ baseUrl, email, password }));
      tokenStore.clear();
      const out = { stored: true, credentialsFile: paths.credentials, baseUrl, email: maskEmail(email), verified: false };
      if (!flags['no-verify']) {
        try {
          const entry = await clientFor({ baseUrl, email, password }).login();
          Object.assign(out, { verified: true, tokenValidUntil: isoFromEpoch(entry.expiresAt) });
        } catch (err) {
          // Wrong credentials are not kept; a network or CAPTCHA problem keeps them so the user need not retype.
          if (err.code === 'auth-failed') { rmSync(paths.credentials, { force: true }); out.stored = false; }
          out.verifyError = { error: err.code, message: err.message };
        }
      }
      console.log(JSON.stringify(out, null, 2));
      if (out.verifyError) process.exit(EXIT[out.verifyError.error] || 1);
      return;
    }
    case 'login': {
      const entry = await clientFor(creds()).bearer({ forceLogin: true });
      console.log(JSON.stringify({ loggedIn: true, tokenValidUntil: isoFromEpoch(entry.expiresAt) }, null, 2));
      return;
    }
    case 'logout':
      tokenStore.clear();
      console.log(JSON.stringify({ loggedOut: true }, null, 2));
      return;
    case 'search': {
      if (flags.collection && !COLLECTIONS.includes(flags.collection)) fail('usage', `--collection must be one of ${COLLECTIONS.join(', ')}`);
      const maxChars = flags['max-chars'] === undefined ? DEFAULT_MAX_CHARS : Number(flags['max-chars']);
      if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 200000) fail('usage', '--max-chars must be an integer from 1 to 200000');
      const c = creds();
      if (!((c.email && c.password) || c.token)) fail('not-configured', 'ComplianceOS credentials are not configured');
      const opts = {
        collection: flags.collection, query: flags.query, in: flags.in, regulator: flags.regulator, docType: flags['doc-type'],
        circular: flags.circular, from: flags.from, to: flags.to, topK: flags['top-k'], offset: flags.offset,
        rerank: Boolean(flags.rerank) && !flags['no-rerank'], latestVersion: flags['latest-version'], fields: flags.fields,
      };
      const { body, response } = await clientFor(c).search(opts);
      console.log(JSON.stringify(normaliseResults(response, {
        baseUrl: c.baseUrl, collection: body.collection, query: body.query, retrievedAt: nowIso(), raw: flags.raw,
        limit: flags['top-k'] === undefined ? 10 : Number(flags['top-k']), regulators: flags.regulator,
        includeEmail: flags['include-email'], keepUnmatched: flags['keep-unmatched'], fullText: flags['full-text'] ? maxChars : 0,
      }), null, 2));
      return;
    }
    default:
      fail('usage', 'usage: search.mjs search --query <text> [flags] | status | set-credentials [--no-verify] | login | logout');
  }
}

main().catch((err) => {
  if (err instanceof ComplianceOsError) fail(err.code, err.message);
  fail('unreachable', err.message);
});
