import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKSPACE } from '../lib/toolchain.mjs';

const load = async () => {
  const mod = await import(pathToFileURL(join(WORKSPACE, '.agents/hooks/maxwell.plugin.mjs')).href);
  return { mod, hooks: await mod.MaxwellPlugin({ directory: WORKSPACE, worktree: WORKSPACE, $: undefined }) };
};

test('the OpenCode plugin runs the Maxwell write guard under node and blocks unsanctioned writes', async () => {
  const { hooks } = await load();
  const before = hooks['tool.execute.before'];
  await assert.rejects(before({ tool: 'write', sessionID: 'ses_plugin_test', callID: 'c1' }, { args: { filePath: join(WORKSPACE, 'company-profile/example-co/scratch-note.txt'), content: 'test' } }), /not a sanctioned path/);
  await assert.rejects(before({ tool: 'apply_patch', sessionID: 'ses_plugin_test', callID: 'c2' }, { args: { patchText: '*** Begin Patch\n*** Add File: notes.md\n+hi\n*** End Patch' } }), /not a sanctioned path/);
  await before({ tool: 'write', sessionID: 'ses_plugin_test', callID: 'c3' }, { args: { filePath: join(WORKSPACE, 'applications/mcp-gateway/README.md'), content: '# mcp-gateway\n' } });
  await before({ tool: 'read', sessionID: 'ses_plugin_test', callID: 'c4' }, { args: { filePath: 'anything.txt' } });
});

test('the OpenCode plugin fails closed when the guard cannot run', async () => {
  const { hooks } = await load();
  const prev = process.env.MAXWELL_NODE;
  process.env.MAXWELL_NODE = '/nonexistent/node';
  try {
    await assert.rejects(hooks['tool.execute.before']({ tool: 'edit', sessionID: 'ses_plugin_test', callID: 'c5' }, { args: { filePath: join(WORKSPACE, 'applications/mcp-gateway/README.md'), newString: 'x' } }), /could not run/);
  } finally {
    if (prev === undefined) delete process.env.MAXWELL_NODE; else process.env.MAXWELL_NODE = prev;
  }
});

test('session start and end are wired to the OpenCode event hook, which is the only way 1.18 delivers them', async () => {
  const { mod, hooks } = await load();
  assert.equal(typeof hooks.event, 'function');
  assert.equal(hooks['session.created'], undefined);
  assert.equal(hooks['session.idle'], undefined);
  assert.deepEqual(mod.filesOf({ patchText: '*** Update File: a.json\n*** Move to: b.json\n*** Delete File: c.md' }), ['a.json', 'b.json', 'c.md']);
});
