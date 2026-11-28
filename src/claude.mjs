// Headless `claude -p` runner. Prompts go in on stdin; structured output comes back via --json-schema.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function claudeBin(env = process.env) {
  return env.MAXWELL_CLAUDE_BIN || 'claude';
}

/** Build argv for one tool-less, settings-free, schema-constrained run. */
export function claudeArgs({ systemPrompt, schema, budgetUsd, model, effort }) {
  const args = [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--system-prompt', systemPrompt,
    '--json-schema', JSON.stringify(schema),
    '--max-budget-usd', budgetUsd.toFixed(4),
  ];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

/** Parse the JSON envelope printed by `claude -p --output-format json`. */
export function parseEnvelope(stdout) {
  const trimmed = stdout.trim();
  let env;
  try {
    env = JSON.parse(trimmed);
  } catch {
    const lastLine = trimmed.split('\n').filter(Boolean).pop() ?? '';
    try {
      env = JSON.parse(lastLine);
    } catch {
      return { ok: false, costUsd: 0, error: 'unparseable claude output' };
    }
  }
  if (Array.isArray(env)) env = env.findLast?.((m) => m?.type === 'result') ?? env[env.length - 1];
  const costUsd = Number(env?.total_cost_usd) || 0;
  let output = env?.structured_output;
  if (output === undefined && typeof env?.result === 'string') {
    const m = /\{[\s\S]*\}/.exec(env.result);
    if (m) {
      try {
        output = JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
  }
  if (env?.is_error || output === undefined || output === null) {
    return { ok: false, costUsd, error: env?.subtype || env?.result || 'no structured output' };
  }
  return { ok: true, costUsd, output };
}

/**
 * Run one headless review. Resolves (never rejects) to { ok, costUsd, output?, error? }.
 */
export function runClaude({ prompt, systemPrompt, schema, budgetUsd, model, effort, timeoutMs, env = process.env }) {
  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'maxwell-web3-'));
    const childEnv = { ...env };
    delete childEnv.CLAUDECODE;
    delete childEnv.CLAUDE_CODE_ENTRYPOINT;
    let child;
    try {
      child = spawn(claudeBin(env), claudeArgs({ systemPrompt, schema, budgetUsd, model, effort }), {
        cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, costUsd: 0, error: String(err?.message || err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      const parsed = parseEnvelope(stdout);
      // A killed run's spend is unknown; charge the full cap so the budget stays conservative.
      finish({ ok: false, costUsd: Math.max(parsed.costUsd, budgetUsd), error: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => finish({ ok: false, costUsd: 0, error: String(err?.message || err) }));
    child.on('close', (code) => {
      const parsed = parseEnvelope(stdout);
      if (!parsed.ok && code !== 0 && !parsed.error) parsed.error = stderr.trim().slice(0, 500) || `exit ${code}`;
      finish(parsed);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

/** True when the claude CLI can be executed. */
export function claudeAvailable(env = process.env) {
  return new Promise((resolve) => {
    try {
      const child = spawn(claudeBin(env), ['--version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}
