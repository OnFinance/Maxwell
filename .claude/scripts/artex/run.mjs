#!/usr/bin/env node
// Run ARTEX v0.3.15 autonomous red-team assessment in a sandboxed environment.
// Invoked by redteam-orchestrator agent through Maxwell's sandbox executor.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ARTEX_BINARY = process.env.ARTEX_BINARY || '/opt/artex/artex';
const ARTEX_VERSION = '0.3.15';

class ArtexRunnerError extends Error {
  constructor(message, code = 'ARTEX_ERROR') {
    super(message);
    this.code = code;
  }
}

function validateConfig(config) {
  const required = ['companyId', 'taskId', 'postgresUrl', 'config'];
  for (const field of required) {
    if (!config[field]) {
      throw new ArtexRunnerError(`Missing required field: ${field}`, 'INVALID_CONFIG');
    }
  }

  const taskConfig = config.config;
  if (!taskConfig.goal || typeof taskConfig.goal !== 'string') {
    throw new ArtexRunnerError('config.goal is required', 'INVALID_CONFIG');
  }

  if (!Array.isArray(taskConfig.rootDomains) || taskConfig.rootDomains.length === 0) {
    throw new ArtexRunnerError('config.rootDomains must be a non-empty array', 'INVALID_CONFIG');
  }

  if (!Array.isArray(taskConfig.allowedDomains) || taskConfig.allowedDomains.length === 0) {
    throw new ArtexRunnerError('config.allowedDomains must be a non-empty array', 'INVALID_CONFIG');
  }

  // Validate timeout (max 6 hours)
  if (taskConfig.timeout && (taskConfig.timeout < 60 || taskConfig.timeout > 21600)) {
    throw new ArtexRunnerError('config.timeout must be between 60 and 21600 seconds', 'INVALID_CONFIG');
  }

  // Validate worker count (1-5)
  if (taskConfig.workers && (taskConfig.workers < 1 || taskConfig.workers > 5)) {
    throw new ArtexRunnerError('config.workers must be between 1 and 5', 'INVALID_CONFIG');
  }
}

function prepareArtexConfig(config) {
  const taskConfig = config.config;
  
  return {
    task: {
      id: config.taskId,
      goal: taskConfig.goal,
      root_domains: taskConfig.rootDomains,
      scope: {
        allowed_cidrs: taskConfig.allowedCIDRs || [],
        denied_cidrs: taskConfig.deniedCIDRs || [],
        allowed_domains: taskConfig.allowedDomains || [],
        prohibited_actions: {
          data_modification: taskConfig.prohibitedActions?.dataModification ?? true,
          data_deletion: taskConfig.prohibitedActions?.dataDeletion ?? true,
          service_disruption: taskConfig.prohibitedActions?.serviceDisruption ?? true,
          credential_bruteforce: taskConfig.prohibitedActions?.credentialBruteforce ?? true,
        }
      }
    },
    planner: {
      debounce_ms: 800
    },
    workers: {
      count: taskConfig.workers || 3,
      rate_limit_per_minute: taskConfig.rateLimit || 30
    },
    guard: {
      mode: taskConfig.guard?.mode || 'strict',
      human_approval_webhook: taskConfig.guard?.humanApprovalWebhook || null,
      auto_approve_tools: taskConfig.guard?.autoApprove || ['nmap', 'curl', 'dig', 'openssl'],
      intervention_log: `/workspace/artex/tasks/${config.taskId}/guard-log.jsonl`
    },
    recording_proxy: {
      enabled: taskConfig.recordingProxy?.enabled ?? true,
      port: taskConfig.recordingProxy?.port || 8788,
      output_dir: `/workspace/artex/tasks/${config.taskId}/proxy-captures`
    },
    database: {
      url: config.postgresUrl
    },
    console: {
      enabled: false, // Never expose console (security)
      port: 0
    },
    timeout_seconds: taskConfig.timeout || 18000
  };
}

async function runArtex(config) {
  // Validate ARTEX binary exists
  if (!existsSync(ARTEX_BINARY)) {
    throw new ArtexRunnerError(
      `ARTEX binary not found at ${ARTEX_BINARY}. Set ARTEX_BINARY env var or install to /opt/artex/`,
      'BINARY_NOT_FOUND'
    );
  }

  // Prepare workspace directories
  const taskDir = `/workspace/artex/tasks/${config.taskId}`;
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(join(taskDir, 'proxy-captures'), { recursive: true });
  mkdirSync(join(taskDir, 'screenshots'), { recursive: true });

  // Write ARTEX configuration
  const artexConfig = prepareArtexConfig(config);
  const configPath = join(taskDir, 'artex-config.json');
  writeFileSync(configPath, JSON.stringify(artexConfig, null, 2));

  // Prepare environment with credentials
  const env = {
    ...process.env,
    ARTEX_CONFIG: configPath,
    POSTGRES_URL: config.postgresUrl,
    ...config.credentials
  };

  // Remove any console-related env vars for security
  delete env.ARTEX_CONSOLE_ENABLED;
  delete env.ARTEX_CONSOLE_PORT;

  console.error(`[artex-runner] Starting ARTEX ${ARTEX_VERSION} for task ${config.taskId}`);
  console.error(`[artex-runner] Goal: ${config.config.goal}`);
  console.error(`[artex-runner] Workers: ${artexConfig.workers.count}`);
  console.error(`[artex-runner] Timeout: ${artexConfig.timeout_seconds}s`);

  return new Promise((resolve, reject) => {
    const artex = spawn(ARTEX_BINARY, ['run', '--config', configPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const stdout = [];
    const stderr = [];

    artex.stdout.on('data', (data) => {
      stdout.push(data);
      process.stdout.write(data);
    });

    artex.stderr.on('data', (data) => {
      stderr.push(data);
      process.stderr.write(data);
    });

    artex.on('close', (code) => {
      const stdoutText = Buffer.concat(stdout).toString();
      const stderrText = Buffer.concat(stderr).toString();

      // Write execution log
      const logPath = join(taskDir, 'execution.log');
      writeFileSync(logPath, `STDOUT:\n${stdoutText}\n\nSTDERR:\n${stderrText}\n`);

      if (code === 0) {
        console.error(`[artex-runner] ARTEX completed successfully`);
        resolve({
          status: 'completed',
          taskId: config.taskId,
          exitCode: code,
          outputDir: taskDir
        });
      } else if (code === 124) { // Timeout
        console.error(`[artex-runner] ARTEX timed out after ${artexConfig.timeout_seconds}s`);
        resolve({
          status: 'timeout',
          taskId: config.taskId,
          exitCode: code,
          outputDir: taskDir
        });
      } else {
        reject(new ArtexRunnerError(
          `ARTEX exited with code ${code}`,
          'ARTEX_FAILED'
        ));
      }
    });

    artex.on('error', (err) => {
      reject(new ArtexRunnerError(
        `Failed to spawn ARTEX: ${err.message}`,
        'SPAWN_ERROR'
      ));
    });

    // Handle timeout at runner level too
    const timeout = setTimeout(() => {
      console.error(`[artex-runner] Killing ARTEX after timeout`);
      artex.kill('SIGTERM');
      setTimeout(() => artex.kill('SIGKILL'), 5000);
    }, artexConfig.timeout_seconds * 1000);

    artex.on('exit', () => clearTimeout(timeout));
  });
}

// Main execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error('Usage: node run.mjs <config.json>');
    console.error('');
    console.error('Config format:');
    console.error(JSON.stringify({
      companyId: 'example-co',
      taskId: 'artex-task-abc123',
      postgresUrl: 'postgresql://user:pass@localhost:5432/artex',
      config: {
        goal: 'validate unauthenticated access to admin endpoints',
        rootDomains: ['example.com'],
        allowedCIDRs: ['13.126.45.0/24'],
        allowedDomains: ['api.example.com'],
        workers: 3,
        timeout: 18000
      },
      credentials: {
        KUBECONFIG: '/workspace/credentials/prod-ro.kubeconfig'
      }
    }, null, 2));
    process.exit(1);
  }

  try {
    const configJson = readFileSync(configPath, 'utf8');
    const config = JSON.parse(configJson);
    
    validateConfig(config);
    const result = await runArtex(config);
    
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(`[artex-runner] ERROR: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

export { runArtex, validateConfig, prepareArtexConfig, ArtexRunnerError };
