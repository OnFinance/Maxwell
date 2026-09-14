import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { convertAgent } from '../sync-agents-mirror.mjs';

// OpenCode 1.18 permission evaluation: wildcard `*` matches anything (a trailing " *" is optional), rules are
// flattened in key order from the global config then the agent, the last matching rule wins, no match asks.
function wildcard(value, pattern) {
  let re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  if (re.endsWith(' .*')) re = re.slice(0, -3) + '( .*)?';
  return new RegExp('^' + re + '$', 's').test(value);
}
function decide(rulesets, permission, value) {
  const expand = (p) => (p.startsWith('~/') ? homedir() + p.slice(1) : p);
  const rules = rulesets.flatMap((set) => Object.entries(set).flatMap(([key, rule]) => (typeof rule === 'string'
    ? [{ permission: key, pattern: '*', action: rule }]
    : Object.entries(rule).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })))));
  return rules.findLast((r) => wildcard(permission, r.permission) && wildcard(value, r.pattern))?.action ?? 'ask';
}
const agent = (tools, disallowed, policy) => {
  const fm = ['---', 'name: t', 'description: test agent', `tools: ${tools}`, ...(disallowed ? [`disallowedTools: ${disallowed}`] : []), '---', 'body'];
  return convertAgent(fm.join('\n'), policy).config.permission;
};
const GLOBAL = { bash: { '*': 'ask', 'sops --decrypt *': 'deny', '*.config/maxwell/*': 'deny' }, webfetch: 'ask' };
const POLICY = { bashAllow: ['ls *'], bashDeny: ['sops --decrypt *', '*.config/maxwell/*', 'curl *'] };

test('an agent shell grant never overrides the global denies', () => {
  const perm = agent('Read, Bash(sops *), Bash(cat *), Bash(node .claude/scripts/cos/search.mjs *)', null, POLICY);
  assert.notEqual(perm.bash, 'allow');
  assert.equal(decide([GLOBAL, perm], 'bash', 'node .claude/scripts/cos/search.mjs search --query "KYC"'), 'allow');
  assert.equal(decide([GLOBAL, perm], 'bash', 'sops --version'), 'allow');
  assert.equal(decide([GLOBAL, perm], 'bash', 'sops --decrypt applications/a/credentials.json'), 'deny');
  assert.equal(decide([GLOBAL, perm], 'bash', 'cat ~/.config/maxwell/complianceos.env'), 'deny');
  assert.equal(decide([GLOBAL, perm], 'bash', 'node -e "fetch(1)"'), 'deny');
  assert.equal(decide([GLOBAL, perm], 'bash', 'curl https://example.com'), 'deny');
});

test('a bare Bash tool gets only the project allow-list', () => {
  const perm = agent('Read, Bash', null, POLICY);
  assert.equal(decide([GLOBAL, perm], 'bash', 'ls applications'), 'allow');
  assert.equal(decide([GLOBAL, perm], 'bash', 'python3 x.py'), 'deny');
});

test('unlisted and disallowed tools are denied; disallowed specifiers narrow a grant', () => {
  const refuter = agent('Read, Grep, Glob, WebFetch', 'Write, Edit, Bash, WebSearch', POLICY);
  assert.equal(refuter.bash, 'deny');
  assert.equal(refuter.edit, 'deny');
  assert.equal(refuter.webfetch, 'allow');
  assert.equal(refuter.task, 'deny');
  const narrowed = agent('Read, Bash(git -C * *)', 'Bash(git -C * push *)', POLICY);
  assert.equal(decide([GLOBAL, narrowed], 'bash', 'git -C applications/a/repos/r log -1'), 'allow');
  assert.equal(decide([GLOBAL, narrowed], 'bash', 'git -C applications/a/repos/r push origin'), 'deny');
});

test('path-scoped writes stay inside their path', () => {
  const perm = agent('Read, Write(kpis/data/raw/sessions/**)', null, POLICY);
  assert.equal(decide([GLOBAL, perm], 'write', 'kpis/data/raw/sessions/opencode/ses_1.jsonl'), 'allow');
  assert.equal(decide([GLOBAL, perm], 'write', 'company-profile/example-co/details.json'), 'deny');
  assert.equal(decide([GLOBAL, perm], 'edit', 'kpis/data/raw/sessions/opencode/ses_1.jsonl'), 'deny');
});

test('agents cannot reach outside the workspace except OpenCode scratch space', () => {
  const perm = agent('Read, Glob', null, POLICY);
  assert.equal(decide([GLOBAL, perm], 'external_directory', '/etc/*'), 'deny');
  assert.equal(decide([GLOBAL, perm], 'external_directory', `${homedir()}/.config/maxwell/*`), 'deny');
  assert.equal(decide([GLOBAL, perm], 'external_directory', `${homedir()}/.local/share/opencode/tool-output/*`), 'allow');
});

test('every generated OpenCode agent is shell-scoped and sandboxed to the workspace', () => {
  const config = JSON.parse(readFileSync('opencode.json', 'utf8'));
  for (const [name, a] of Object.entries(config.agent)) {
    const perm = a.permission;
    assert.ok(perm, `${name} has no permission map`);
    assert.ok(perm.bash === 'deny' || Object.entries(perm.bash)[0].join() === '*,deny', `${name}: bash must start from deny`);
    assert.equal(decide([config.permission, perm], 'external_directory', '/etc/*'), 'deny', name);
    for (const cmd of ['sops --decrypt applications/a/credentials.json', 'cat ~/.config/maxwell/complianceos.env', 'head ~/.cache/maxwell/complianceos-token.json', 'rm -rf company-profile']) {
      assert.equal(decide([config.permission, perm], 'bash', cmd), 'deny', `${name}: ${cmd}`);
    }
  }
});
