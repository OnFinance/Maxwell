// OpenCode plugin: bridges OpenCode events to the same Maxwell hook scripts Claude Code runs.
// Registered from opencode.json: "plugin": ["./.agents/hooks/maxwell.plugin.mjs"].
// Semantics mirror .claude/settings.json: guard before writes, validate after writes, session meta at start,
// transcript ingest when the session goes idle. A blocked write throws so OpenCode reports the reason, and a guard that
// cannot run blocks the write as well (fail closed).
// Hooks run under node, never process.execPath: inside OpenCode that is the opencode binary, which takes the hook script
// for a project directory and exits 0, so every hook silently passed (found in the GLM 5.3 e2e run, 2026-09-14).
// OpenCode 1.18 has no session.created or session.idle plugin hooks; both arrive through the generic event hook.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const WRITE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit', 'apply_patch']);

export function runHook(root, script, payload, env = {}) {
  const res = spawnSync(process.env.MAXWELL_NODE || 'node', [resolve(root, '.claude/hooks', script)], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, MAXWELL_HARNESS: 'opencode', CLAUDE_PROJECT_DIR: root, ...env },
  });
  return { status: res.error ? null : res.status, stdout: res.stdout || '', stderr: res.stderr || (res.error ? String(res.error.message) : '') };
}

// Files a write tool call touches: filePath for write and edit, the file headers of an apply_patch patch.
export function filesOf(args = {}) {
  if (args.filePath || args.path) return [args.filePath || args.path];
  const patch = String(args.patchText || args.patch || '');
  return [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((m) => m[1].trim());
}

export const MaxwellPlugin = async ({ directory, worktree, $ }) => {
  const root = worktree || directory;
  let version = 'unknown';
  try { version = (await $`opencode --version`.text()).trim(); } catch { /* ignore */ }
  return {
    event: async ({ event }) => {
      const sessionId = event?.properties?.sessionID || event?.properties?.info?.id;
      if (!sessionId) return;
      if (event.type === 'session.created') runHook(root, 'session-start.mjs', { session_id: sessionId, cwd: root }, { MAXWELL_HARNESS_VERSION: version });
      if (event.type === 'session.idle') runHook(root, 'session-end.mjs', { session_id: sessionId, cwd: root }, { MAXWELL_HARNESS_VERSION: version });
    },
    'chat.message': async (input, output) => {
      const text = (output?.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      if (text) runHook(root, 'user-prompt.mjs', { session_id: input?.sessionID, cwd: root, prompt: text });
    },
    'tool.execute.before': async (input, output) => {
      if (!WRITE_TOOLS.has(String(input?.tool || '').toLowerCase())) return;
      const args = output?.args || {};
      const files = filesOf(args);
      if (!files.length) throw new Error(`[maxwell] BLOCKED: this ${input.tool} call names no file the write guard can check`);
      for (const file of files) {
        const res = runHook(root, 'guard-write.mjs', { session_id: input?.sessionID, cwd: root, tool_name: input.tool, tool_input: { file_path: file, content: args.content ?? args.patchText, new_string: args.newString || args.new_string } });
        if (res.status === 2) throw new Error(res.stderr.trim());
        if (res.status !== 0) throw new Error(`[maxwell] BLOCKED: the write guard could not run for ${file} (exit ${res.status}): ${res.stderr.trim().slice(0, 300)}`);
      }
    },
    'tool.execute.after': async (input, output) => {
      if (!WRITE_TOOLS.has(String(input?.tool || '').toLowerCase())) return;
      const args = output?.args || input?.args || {};
      for (const file of filesOf(args)) {
        const res = runHook(root, 'validate-write.mjs', { session_id: input?.sessionID, cwd: root, tool_name: input.tool, tool_input: { file_path: file } });
        if (res.status !== 0 && output) output.output = `${output.output || ''}\n${res.status === 2 ? res.stderr.trim() : `[maxwell] validation could not run for ${file} (exit ${res.status}); run npm run validate`}`;
      }
    },
  };
};

export default MaxwellPlugin;
