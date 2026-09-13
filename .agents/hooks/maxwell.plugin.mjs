// OpenCode plugin: bridges OpenCode events to the same Maxwell hook scripts Claude Code runs.
// Registered from opencode.json: "plugin": ["./.agents/hooks/maxwell.plugin.mjs"].
// Semantics mirror .claude/settings.json: guard before writes, validate after writes, session meta at start,
// transcript ingest when the session goes idle. A blocked write throws so OpenCode reports the reason.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const WRITE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit']);

function runHook(root, script, payload, env = {}) {
  const res = spawnSync(process.execPath, [resolve(root, '.claude/hooks', script)], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, MAXWELL_HARNESS: 'opencode', CLAUDE_PROJECT_DIR: root, ...env },
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

export const MaxwellPlugin = async ({ directory, worktree, $ }) => {
  const root = worktree || directory;
  let version = 'unknown';
  try { version = (await $`opencode --version`.text()).trim(); } catch { /* ignore */ }
  return {
    'session.created': async ({ session }) => {
      runHook(root, 'session-start.mjs', { session_id: session?.id, cwd: root }, { MAXWELL_HARNESS_VERSION: version });
    },
    'chat.message': async (input, output) => {
      const text = (output?.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      if (text) runHook(root, 'user-prompt.mjs', { session_id: input?.sessionID, cwd: root, prompt: text });
    },
    'tool.execute.before': async (input, output) => {
      if (!WRITE_TOOLS.has(String(input?.tool || '').toLowerCase())) return;
      const args = output?.args || {};
      const res = runHook(root, 'guard-write.mjs', { session_id: input?.sessionID, cwd: root, tool_name: input.tool, tool_input: { file_path: args.filePath || args.path, content: args.content, new_string: args.newString || args.new_string } });
      if (res.status === 2) throw new Error(res.stderr.trim());
    },
    'tool.execute.after': async (input, output) => {
      if (!WRITE_TOOLS.has(String(input?.tool || '').toLowerCase())) return;
      const args = output?.args || input?.args || {};
      const res = runHook(root, 'validate-write.mjs', { session_id: input?.sessionID, cwd: root, tool_name: input.tool, tool_input: { file_path: args.filePath || args.path } });
      if (res.status === 2 && output) output.output = `${output.output || ''}\n${res.stderr.trim()}`;
    },
    'session.idle': async ({ session }) => {
      runHook(root, 'session-end.mjs', { session_id: session?.id, cwd: root }, { MAXWELL_HARNESS_VERSION: version });
    },
  };
};

export default MaxwellPlugin;
