import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkPipeline, splitStages, SECRET_KEY_FILTER } from '../lib/sandbox/command-policy.mjs';

const allowlist = JSON.parse(readFileSync('.claude/skills/runtime-probe-rules-of-engagement/references/command-allowlist.json', 'utf8'));
const urls = ['https://api.example.in/v1/', 'https://status.example.in/'];
const run = (argv, ctx = {}) => checkPipeline(splitStages(argv), { allowlist, urls, method: 'kubeconfig', tier: 'qa', ...ctx });
const ok = (argv, ctx) => { const r = run(argv, ctx); assert.equal(r.ok, true, `${argv.join(' ')} -> ${r.reason}`); };
const no = (argv, ctx, re) => { const r = run(argv, ctx); assert.equal(r.ok, false, `${argv.join(' ')} should be refused`); if (re) assert.match(r.reason, re); };

test('kubectl reads pass and writes are refused', () => {
  ok(['kubectl', 'get', 'pods', '-A', '-o', 'json'], { tier: 'prod' });
  ok(['kubectl', 'auth', 'can-i', '--list'], { tier: 'prod' });
  no(['kubectl', 'delete', 'pod', 'x'], {}, /allow-list/);
  no(['kubectl', 'exec', '-it', 'pod', '--', 'sh'], {}, /allow-list/);
  no(['kubectl', 'auth', 'reconcile', '-f', 'x.yaml'], {}, /can-i|forbidden|not allowed/);
  no(['kubectl', 'cluster-info', 'dump'], {}, /dump/);
  no(['kubectl', 'config', 'view', '--raw'], {}, /raw|allow-list/);
});

test('kubectl credentials, raw API paths and follow modes are refused', () => {
  no(['kubectl', 'get', 'pods', '--kubeconfig', '/tmp/k'], {}, /credential locator/);
  no(['kubectl', 'get', '--raw', '/api/v1/secrets'], {}, /--raw/);
  no(['kubectl', 'get', 'pods', '-w'], {}, /-w/);
});

test('kubectl secrets: names or key-only JSON on lower tiers, nothing on prod', () => {
  ok(['kubectl', 'get', 'secrets', '-n', 'app', '-o', 'name']);
  ok(['kubectl', 'get', 'secrets', '-n', 'app', '-o', 'json', '--pipe', 'jq', SECRET_KEY_FILTER]);
  no(['kubectl', 'get', 'secrets', '-n', 'app', '-o', 'yaml'], {}, /-o name/);
  no(['kubectl', 'get', 'secrets', '-o', 'json', '--pipe', 'jq', '.items'], {}, /-o name/);
  no(['kubectl', 'get', 'pods,secret/db', '-o', 'name'], { tier: 'prod' }, /never read/);
  no(['kubectl', 'describe', 'secret', 'db'], {}, /only be listed/);
  no(['kubectl', 'get', 'secrets', '-o', 'name'], { tier: 'dr' }, /never read/);
});

test('kubectl logs only below prod, bounded by --tail and --since', () => {
  ok(['kubectl', 'logs', 'deploy/api', '--tail=100', '--since=1h']);
  no(['kubectl', 'logs', 'deploy/api', '--tail=100', '--since=1h'], { tier: 'prod' }, /not allowed on a prod tier/);
  no(['kubectl', 'logs', 'deploy/api'], {}, /--tail/);
  no(['kubectl', 'logs', 'deploy/api', '--tail=10', '--since=1h', '-f'], {}, /-f/);
});

test('docker: read verbs through the socket proxy, inspect only with a format', () => {
  const ctx = { method: 'docker-socket' };
  ok(['docker', 'ps', '-a'], ctx);
  ok(['docker', 'inspect', '--format', '{{json .Config.User}}', 'api'], ctx);
  no(['docker', 'inspect', 'api'], ctx, /--format/);
  no(['docker', 'run', 'alpine'], ctx, /allow-list/);
  no(['docker', '-H', 'tcp://10.0.0.1:2375', 'ps'], ctx, /-H/);
});

test('cloud CLIs: read verbs pass; secret, credential and write verbs are refused', () => {
  const ctx = { method: 'cloud-api', tier: 'prod' };
  ok(['aws', 'ec2', 'describe-instances', '--region', 'ap-south-1'], ctx);
  ok(['aws', 's3api', 'get-object-lock-configuration', '--bucket', 'b'], ctx);
  ok(['aws', 'lambda', 'get-function-configuration', '--function-name', 'f'], ctx);
  ok(['gcloud', 'projects', 'get-iam-policy', 'p'], ctx);
  ok(['az', 'role', 'assignment', 'list'], ctx);
  ok(['az', 'network', 'nsg', 'rule', 'list', '-g', 'rg', '--nsg-name', 'n'], ctx);
  no(['aws', 'ec2', 'run-instances'], ctx, /allow-list/);
  no(['aws', 's3api', 'get-object', '--bucket', 'b', '--key', 'k', 'out'], ctx, /secret/);
  no(['aws', 'lambda', 'get-function', '--function-name', 'f'], ctx, /secret/);
  no(['aws', 'secretsmanager', 'get-secret-value', '--secret-id', 's'], ctx, /secret/);
  no(['aws', 'ssm', 'describe-parameters', '--with-decryption'], ctx, /--with-decryption/);
  no(['aws', 'ec2', 'describe-instances', '--profile', 'admin'], ctx, /credential locator/);
  no(['az', 'keyvault', 'secret', 'show', '--name', 's'], ctx, /secret/);
  no(['az', 'aks', 'get-credentials', '-n', 'c'], ctx, /secret|credential/);
  no(['gcloud', 'container', 'clusters', 'get-credentials', 'c'], ctx, /credential/);
  no(['gcloud', 'auth', 'print-access-token'], ctx, /credential/);
});

test('hard rules hold even when an allow-list entry is too broad', () => {
  const broad = { ...allowlist, families: { ...allowlist.families, aws: { method: 'cloud-api', allow: [{ argv: ['aws', 'secretsmanager', 'get-*'] }, { argv: ['aws', 'ec2', '*'] }] } } };
  assert.equal(checkPipeline([['aws', 'secretsmanager', 'get-secret-value']], { allowlist: broad, method: 'cloud-api', tier: 'dev' }).ok, false);
  assert.match(checkPipeline([['aws', 'ec2', 'terminate-instances']], { allowlist: broad, method: 'cloud-api', tier: 'dev' }).reason, /write verb/);
});

test('the binary must belong to the environment access method', () => {
  no(['aws', 'sts', 'get-caller-identity'], { method: 'kubeconfig' }, /not allowed for probeAccess.method kubeconfig/);
  no(['kubectl', 'get', 'pods'], { method: 'none' }, /permits no commands/);
  no(['kubectl', 'get', 'pods'], { tier: undefined }, /tier/);
});

test('http-only: HEAD or GET to declared URLs and well-known paths only', () => {
  const ctx = { method: 'http-only', tier: 'prod' };
  ok(['curl', '-sS', '-I', 'https://api.example.in/v1/health'], ctx);
  ok(['curl', '-sS', '-X', 'GET', 'https://status.example.in/.well-known/security.txt', '-H', 'Origin: https://maxwell-probe.invalid'], ctx);
  ok(['openssl', 's_client', '-connect', 'api.example.in:443', '-servername', 'api.example.in', '-tls1_2'], ctx);
  no(['curl', '-sS', '-I', 'https://evil.example.com/'], ctx, /not in the environment/);
  no(['curl', '-sS', '-X', 'POST', 'https://api.example.in/v1/'], ctx, /not allowed|HEAD/);
  no(['curl', '-sS', '-d', 'x=1', 'https://api.example.in/v1/'], ctx, /not allowed/);
  no(['curl', '-sS', '-I', 'https://api.example.in/admin'], ctx, /path/);
  no(['openssl', 's_client', '-connect', 'other.example.com:443'], ctx, /not in the environment/);
});

test('ssh: the fixed form with a command from the read list', () => {
  const base = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', 'host01'];
  const ctx = { method: 'ssh', tier: 'qa' };
  ok([...base, 'ls -la /etc/nginx'], ctx);
  ok([...base, 'journalctl --no-pager -n 200 -u nginx.service'], ctx);
  no([...base, 'rm -rf /'], ctx, /read list/);
  no([...base, 'ls -la /etc; cat /etc/shadow'], ctx, /read list/);
  no(['ssh', 'host01', 'uname -a'], ctx, /exactly/);
});

test('pipe stages: jq, grep and head -c over the previous output only', () => {
  ok(['kubectl', 'get', 'pods', '-o', 'json', '--pipe', 'jq', '-c', '.items[].metadata.name', '--pipe', 'head', '-c', '1048576']);
  no(['kubectl', 'get', 'pods', '--pipe', 'jq', '.', '/etc/passwd'], {}, /one filter/);
  no(['kubectl', 'get', 'pods', '--pipe', 'jq', '--rawfile', 'x', '/etc/shadow', '.'], {}, /reads local files/);
  no(['kubectl', 'get', 'pods', '--pipe', 'grep', '-r', 'x'], {}, /reads local files/);
  no(['kubectl', 'get', 'pods', '--pipe', 'head', '-n', '5'], {}, /head -c/);
  no(['kubectl', 'get', 'pods', '--pipe', 'tee', 'out.txt'], {}, /pipe stage not allowed/);
  no(['kubectl', 'get', 'pods\nkubectl delete pod x'], {}, /newlines/);
});

test('no allow-list entry is itself a write, secret or credential verb', () => {
  for (const [bin, family] of Object.entries(allowlist.families)) {
    for (const entry of family.allow || []) {
      const argv = entry.argv.map((t) => (t === '*' ? 'x' : t.endsWith('*') ? `${t.slice(0, -1)}x` : t));
      const r = checkPipeline([bin === 'docker' && argv.includes('inspect') ? [...argv, '--format', '{{.Id}}'] : bin === 'kubectl' && argv[1] === 'logs' ? [...argv, '--tail=1', '--since=1m'] : argv], { allowlist, method: family.method, tier: 'dev' });
      assert.equal(r.ok, true, `${entry.argv.join(' ')}: ${r.reason}`);
    }
  }
});
