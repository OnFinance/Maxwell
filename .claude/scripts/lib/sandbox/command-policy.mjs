// Decides whether one read-only runtime probe command may run, before any executor sees it. This is the security
// boundary for sandbox/exec.mjs: agents are allowed to call exec.mjs with any arguments, so every rule of the
// runtime-probe-rules-of-engagement skill (section 2) that can be checked mechanically is checked here.
// A command is an array of pipeline stages; each stage is an argv array (no shell is ever involved).
//   checkPipeline(stages, { allowlist, method, tier, urls }) -> { ok: true, family } | { ok: false, reason }
// The allow-list data lives in runtime-probe-rules-of-engagement/references/command-allowlist.json; the hard rules
// below apply even when a (mistaken) allow-list entry matches.

export const PROD_TIERS = ['prod', 'dr'];

// The binary each probeAccess.method may run.
export const METHOD_BINARIES = {
  kubeconfig: ['kubectl'],
  'docker-socket': ['docker'],
  'cloud-api': ['aws', 'gcloud', 'az', 'crane', 'cosign'],
  'http-only': ['curl', 'openssl'],
  ssh: ['ssh'],
};

// Credentials, identities and endpoints are injected by exec.mjs from the environment's credential locator, never
// passed by the agent; flags that follow output forever would hang the probe.
const FORBIDDEN_FLAGS = {
  kubectl: ['--raw', '--kubeconfig', '--token', '--as', '--as-group', '--as-uid', '--server', '-s', '--username', '--password', '--client-key', '--client-certificate', '--certificate-authority', '--insecure-skip-tls-verify', '--follow', '-f', '--watch', '-w', '--watch-only'],
  docker: ['-H', '--host', '--context', '-c', '--config', '--tls', '--tlsverify', '--tlscacert', '--tlscert', '--tlskey'],
  aws: ['--profile', '--endpoint-url', '--with-decryption', '--no-verify-ssl', '--ca-bundle'],
  gcloud: ['--account', '--impersonate-service-account', '--access-token-file', '--credential-file-override'],
  az: ['--auth-mode'],
  crane: ['--insecure'],
  cosign: ['--allow-insecure-registry', '--key'],
};

// Reads that return a secret or mint a credential (section 2, cloud-api and object-store rows).
const SECRET_VERBS = [
  /^aws secretsmanager get-secret-value\b/, /^aws ssm get-parameters?\b/, /^aws ecr get-(login-password|authorization-token)\b/,
  /^aws sts (get-session-token|get-federation-token|assume-role)/, /^aws eks get-token\b/, /^aws lambda get-function\b(?!-configuration)/,
  /^aws iam create-access-key\b/, /^aws s3api get-object\b(?!-lock-configuration)/, /^aws s3 (cp|sync|presign|mv|rm)\b/,
  /^aws sqs (receive-message|purge-queue)\b/, /^aws kms decrypt\b/,
  /^az keyvault secret (show|download)\b/, /^az .*\bkeys list\b/, /^az .*\blist-keys\b/, /^az aks get-credentials\b/, /^az account get-access-token\b/,
  /^gcloud .*\bget-credentials\b/, /^gcloud secrets versions access\b/, /^gcloud auth print-/,
  /^crane auth\b/, /^cosign (sign|attest)\b/,
];

// Any verb word that changes state; checked on the command words of every cloud, kubectl and docker command.
const WRITE_WORD = /^(put|create|update|delete|attach|detach|run|start|stop|invoke|modify|terminate|reboot|associate|disassociate|register|deregister|tag|untag|enable|disable|set|reset|restore|revoke|authorize|import|export|copy|replace|cancel|send|publish|upload|apply|patch|edit|scale|rollout|exec|cp|port-forward|proxy|debug|drain|cordon|uncordon|label|annotate|taint|rm|rmi|pull|push|build|commit|kill|login|logout|mutate|append|flatten|rebase|sign|attest)(-|$)/;

const KUBECTL_VALUE_FLAGS = new Set(['-n', '--namespace', '-o', '--output', '-l', '--selector', '--field-selector', '--context', '--tail', '--since', '-c', '--container', '--sort-by', '--template', '--chunk-size', '--request-timeout', '--subresource']);
export const SECRET_KEY_FILTER = '[.items[] | {name: .metadata.name, type: .type, keys: ((.data // {}) | keys)}]';

const fail = (reason) => ({ ok: false, reason });

function flagName(token) {
  return token.startsWith('--') ? token.split('=')[0] : token;
}

function hasForbiddenFlag(bin, argv) {
  const banned = FORBIDDEN_FLAGS[bin] || [];
  return argv.slice(1).map(flagName).find((f) => banned.includes(f));
}

function tokenMatches(pattern, token) {
  return pattern.endsWith('*') ? token.startsWith(pattern.slice(0, -1)) : pattern === token;
}

export function matchesEntry(entry, argv) {
  return entry.argv.length <= argv.length && entry.argv.every((p, i) => tokenMatches(p, argv[i]));
}

function kubectlParse(argv) {
  const positionals = [];
  const flags = new Map();
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t.startsWith('--') && t.includes('=')) { const [k, v] = t.split(/=(.*)/s); flags.set(k, v); continue; }
    if (KUBECTL_VALUE_FLAGS.has(t)) { flags.set(t, argv[i + 1]); i += 1; continue; }
    if (t.startsWith('-')) { flags.set(t, true); continue; }
    positionals.push(t);
  }
  return { positionals, flags };
}

function kubectlRules(stages, tier) {
  const argv = stages[0];
  const verb = argv[1];
  const { positionals, flags } = kubectlParse(argv);
  const output = flags.get('-o') ?? flags.get('--output');
  const prod = PROD_TIERS.includes(tier);
  if (verb === 'config') return fail('kubectl config is not a probe command');
  if (verb === 'cluster-info' && positionals.includes('dump')) return fail('kubectl cluster-info dump prints every resource, including secrets');
  if (verb === 'auth' && positionals[0] !== 'can-i') return fail('only kubectl auth can-i is allowed');
  if (verb === 'logs') {
    if (prod) return fail(`kubectl logs is not allowed on a ${tier} tier: logs carry customer data (rules of engagement section 2)`);
    if (!flags.has('--tail') || !flags.has('--since')) return fail('kubectl logs needs --tail=<n> and --since=<duration>');
  }
  const touchesSecrets = positionals.some((p) => p.split(/[,/]/).some((part) => /^secrets?$/i.test(part)));
  if (touchesSecrets) {
    if (prod) return fail(`secrets are never read on a ${tier} tier, not even their names`);
    if (verb !== 'get') return fail('secrets may only be listed with kubectl get');
    const pipeline = stages.slice(1);
    const names = output === 'name';
    const keyOnly = output === 'json' && pipeline.length >= 1 && pipeline[0][0] === 'jq' && pipeline[0].slice(1).filter((t) => !t.startsWith('-')).join(' ') === SECRET_KEY_FILTER;
    if (!names && !keyOnly) return fail(`secrets may be listed only with -o name, or -o json piped into jq '${SECRET_KEY_FILTER}'`);
  }
  return { ok: true };
}

function dockerRules(argv) {
  if (argv[1] === 'inspect' || (['container', 'image', 'network', 'volume'].includes(argv[1]) && argv[2] === 'inspect')) {
    if (!argv.some((t) => t === '-f' || t === '--format' || t.startsWith('--format='))) return fail('docker inspect needs a --format template (rules of engagement section 6); a bare inspect prints environment values');
  }
  return { ok: true };
}

function hostOf(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return null; }
}

const WELL_KNOWN = ['/.well-known/security.txt', '/health/live', '/health/ready', '/robots.txt'];

function curlRules(argv, urls) {
  const allowedHosts = new Set((urls || []).map(hostOf).filter(Boolean));
  let method = null; let target = null;
  for (let i = 1; i < argv.length; i += 1) {
    const t = argv[i];
    if (['-s', '-S', '-sS', '-Ss', '--silent', '--show-error'].includes(t)) continue;
    if (t === '-I' || t === '--head') { method = 'HEAD'; continue; }
    if (t === '-X' && argv[i + 1] === 'GET') { method = 'GET'; i += 1; continue; }
    if (t === '-H' && argv[i + 1] === 'Origin: https://maxwell-probe.invalid') { i += 1; continue; }
    if (t === '--max-time' && /^\d{1,3}$/.test(argv[i + 1] || '')) { i += 1; continue; }
    if (!t.startsWith('-') && target === null) { target = t; continue; }
    return fail(`curl option or argument not allowed: ${t}`);
  }
  if (!method) return fail('curl must be a HEAD (-I) or an explicit -X GET request');
  if (!target || !/^https?:\/\//.test(target)) return fail('curl needs one absolute http(s) URL');
  const u = new URL(target);
  if (!allowedHosts.has(u.host.toLowerCase())) return fail(`curl target ${u.host} is not in the environment's urls[]`);
  const declared = (urls || []).some((d) => { try { const x = new URL(d); return x.host.toLowerCase() === u.host.toLowerCase() && u.pathname.startsWith(x.pathname.replace(/\/$/, '') || '/'); } catch { return false; } });
  if (!declared && !WELL_KNOWN.includes(u.pathname)) return fail(`curl path ${u.pathname} is neither under a declared URL nor a well-known probe path`);
  return { ok: true };
}

function opensslRules(argv, urls) {
  const hosts = new Set((urls || []).map(hostOf).filter(Boolean).map((h) => h.split(':')[0]));
  if (argv[1] !== 's_client') return fail('only openssl s_client is allowed');
  let connect = null; let sni = null;
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '-connect') { connect = argv[i + 1]; i += 1; continue; }
    if (t === '-servername') { sni = argv[i + 1]; i += 1; continue; }
    if (['-tls1_1', '-tls1_2', '-tls1_3', '-brief'].includes(t)) continue;
    return fail(`openssl option not allowed: ${t}`);
  }
  const m = /^([a-z0-9.-]+):443$/i.exec(connect || '');
  if (!m) return fail('openssl s_client needs -connect <host>:443');
  if (!hosts.has(m[1].toLowerCase())) return fail(`openssl target ${m[1]} is not in the environment's urls[]`);
  if (sni && sni.toLowerCase() !== m[1].toLowerCase()) return fail('-servername must equal the -connect host');
  return { ok: true };
}

function sshRules(argv, allowlist) {
  const expected = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes'];
  if (argv.length !== 7 || !expected.every((t, i) => argv[i] === t)) return fail("ssh must be exactly: ssh -o BatchMode=yes -o StrictHostKeyChecking=yes <host> '<command>'");
  if (!/^[A-Za-z0-9._@-]+$/.test(argv[5])) return fail('ssh host must be a plain host name');
  const remote = argv[6];
  const ok = (allowlist.ssh && allowlist.ssh.remoteCommands || []).some((pattern) => new RegExp(`^${pattern}$`).test(remote));
  return ok ? { ok: true } : fail(`remote command is not on the ssh read list: ${remote}`);
}

function pipeStageRules(stage, allowlist) {
  const allowed = (allowlist.pipeStages || []).some((e) => matchesEntry(e, stage));
  if (!allowed) return fail(`pipe stage not allowed: ${stage[0]} (only jq, grep and head -c)`);
  if (stage[0] === 'jq') {
    const banned = stage.find((t) => ['-f', '--from-file', '--rawfile', '--slurpfile', '-L'].includes(flagName(t)));
    if (banned) return fail(`jq ${banned} reads local files`);
    const positionals = stage.slice(1).filter((t) => !t.startsWith('-'));
    if (positionals.length > 1) return fail('jq takes one filter and reads only the previous stage');
  }
  if (stage[0] === 'grep') {
    const banned = stage.find((t) => ['-r', '-R', '--recursive', '-f', '--file', '-d', '--directories'].includes(flagName(t)));
    if (banned) return fail(`grep ${banned} reads local files`);
    if (stage.slice(1).filter((t) => !t.startsWith('-')).length > 1) return fail('grep takes one pattern and reads only the previous stage');
  }
  if (stage[0] === 'head' && !(stage.length === 3 && stage[1] === '-c' && /^\d{1,8}$/.test(stage[2]))) return fail('head is allowed only as head -c <bytes>');
  return { ok: true };
}

export function checkPipeline(stages, { allowlist, method, tier, urls } = {}) {
  if (!Array.isArray(stages) || !stages.length || stages.some((s) => !Array.isArray(s) || !s.length || s.some((t) => typeof t !== 'string'))) return fail('command must be a non-empty list of argv arrays');
  if (!allowlist || !allowlist.families) return fail('no command allow-list loaded');
  if (!method || method === 'none') return fail(`probeAccess.method ${method || '(missing)'} permits no commands`);
  if (!tier) return fail('the environment tier is required');
  const argv = stages[0];
  const bin = argv[0];
  if ((stages.flat().some((t) => t.includes('\n') || t.includes('\0')))) return fail('arguments may not contain newlines or NUL bytes');
  if (!(METHOD_BINARIES[method] || []).includes(bin)) return fail(`${bin} is not allowed for probeAccess.method ${method} (allowed: ${(METHOD_BINARIES[method] || []).join(', ') || 'none'})`);
  const banned = hasForbiddenFlag(bin, argv);
  if (banned) return fail(`${bin} ${banned} is not allowed: credentials, identities and endpoints come from the environment's credential locator`);
  const words = argv.filter((t, i) => i > 0 && !t.startsWith('-')).slice(0, 4);
  const line = [bin, ...argv.slice(1).filter((t) => !t.startsWith('-'))].join(' ');
  if (SECRET_VERBS.some((re) => re.test(line))) return fail(`${line.split(' ').slice(0, 3).join(' ')} returns a secret or mints a credential`);

  const family = allowlist.families[bin];
  if (!family) return fail(`no allow-list for ${bin}`);
  if (bin === 'ssh') {
    const r = sshRules(argv, allowlist);
    if (!r.ok) return r;
  } else if (bin === 'curl' || bin === 'openssl') {
    const r = bin === 'curl' ? curlRules(argv, urls) : opensslRules(argv, urls);
    if (!r.ok) return r;
  } else {
    const entry = (family.allow || []).find((e) => matchesEntry(e, argv));
    if (!entry) return fail(`not on the read-only allow-list: ${words.length ? `${bin} ${words.slice(0, 3).join(' ')}` : bin}`);
    if (entry.tiers && !entry.tiers.includes(tier)) return fail(`${entry.argv.join(' ')} is not allowed on a ${tier} tier`);
    const commandWords = argv.slice(1, entry.argv.length);
    if (commandWords.some((w) => WRITE_WORD.test(w) && !(entry.readOnlyWords || []).includes(w))) return fail(`${entry.argv.join(' ')} looks like a write verb`);
    if (bin === 'kubectl') { const r = kubectlRules(stages, tier); if (!r.ok) return r; }
    if (bin === 'docker') { const r = dockerRules(argv); if (!r.ok) return r; }
  }
  for (const stage of stages.slice(1)) {
    const r = pipeStageRules(stage, allowlist);
    if (!r.ok) return r;
  }
  return { ok: true, family: method };
}

// "kubectl get pods -A --pipe jq .items --pipe head -c 1048576" style argv -> stages.
export function splitStages(argv, separator = '--pipe') {
  const stages = [[]];
  for (const t of argv) {
    if (t === separator) stages.push([]);
    else stages[stages.length - 1].push(t);
  }
  return stages;
}
