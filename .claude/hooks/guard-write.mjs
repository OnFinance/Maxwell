#!/usr/bin/env node
// PreToolUse hook for Write/Edit/MultiEdit (and the OpenCode tool.execute.before equivalent).
// Blocks: writes outside the workspace or outside the sanctioned layout, schema edits without
// MAXWELL_SCHEMA_EDIT=1, plaintext secrets, and unencrypted credentials.json content. Exit 2 = block.
import { readStdinJson, workspaceRoot, toWorkspacePath, findSecret, block } from './lib.mjs';
import { loadLayout, matchRule } from '../scripts/lib/layout.mjs';
import { resolve } from 'node:path';

const input = readStdinJson();
const root = workspaceRoot(input);
const toolInput = input.tool_input || {};
const filePath = toolInput.file_path || toolInput.path || toolInput.filePath;
if (!filePath) process.exit(0);

const rel = toWorkspacePath(root, filePath);
if (!rel) block(`${filePath} is outside the workspace. Maxwell only writes inside its own layout.`);

const layout = loadLayout(resolve(root, '.claude/schemas/layout.json'));
const rule = matchRule(layout, rel);
if (!rule) block(`${rel} is not a sanctioned path. See .claude/schemas/layout.json and AGENTS.md §1; record the information in an existing artefact instead.`);
if (/^applications\/[^/]+\/repos\/[^/]+\//.test(rel)) block(`${rel} is inside a cloned application checkout. Never modify target repositories; write a suggestion diff instead.`);

if (rel.startsWith('.claude/schemas/') && process.env.MAXWELL_SCHEMA_EDIT !== '1') {
  block(`${rel}: schema edits are not allowed during workflows (set MAXWELL_SCHEMA_EDIT=1 for a reviewed schema change).`);
}
if (rel.startsWith('.agents/') && !rel.startsWith('.agents/skills/') && !rel.startsWith('.agents/hooks/') && process.env.MAXWELL_MIRROR_EDIT !== '1') {
  block(`${rel} is generated from .claude/. Edit the canonical file and run \`npm run sync:agents\`.`);
}

const content = [toolInput.content, toolInput.new_string, ...(Array.isArray(toolInput.edits) ? toolInput.edits.map((e) => e.new_string) : [])].filter(Boolean).join('\n');
const secret = findSecret(content);
if (secret) block(`content for ${rel} contains what looks like a ${secret}. Store a reference in credentials.json instead (AGENTS.md §5).`);

if (rule.format === 'sops-json' && content && !/"sops"\s*:/.test(content)) {
  block(`${rel} must be written sops-encrypted. Use: node .claude/scripts/creds/sops.mjs encrypt <app_id> <decrypted.json>`);
}
process.exit(0);
