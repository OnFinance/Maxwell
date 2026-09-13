#!/usr/bin/env node
// PostToolUse hook for Write/Edit/MultiEdit: validates the touched file against its layout rule/schema.
// Exit 2 feeds the validator's message back to the agent so it corrects the file.
import { readStdinJson, workspaceRoot, toWorkspacePath, runValidator } from './lib.mjs';

const input = readStdinJson();
const root = workspaceRoot(input);
const toolInput = input.tool_input || {};
const filePath = toolInput.file_path || toolInput.path || toolInput.filePath;
const rel = toWorkspacePath(root, filePath);
if (!rel) process.exit(0);
if (/^applications\/[^/]+\/repos\/[^/]+\//.test(rel)) process.exit(0);

const { ok, output } = runValidator(root, rel);
if (!ok) {
  process.stderr.write(`[maxwell] ${rel} failed validation. Fix the content to match its schema (do not edit the schema):\n${output}\n`);
  process.exit(2);
}
process.exit(0);
