// Prepares a pinned tool for a hosted sandbox. Hosted providers start from a pinned base image (Daytona, Modal) or
// from their own default image (E2B, Vercel Sandbox), so the tool travels in the upload bundle:
//   binary  the checksum-verified linux-amd64 release binary
//   site    hash-locked wheels installed for linux-amd64 on this machine, run with the pinned Python base image
//   uv      the verified uv binary and the lock, installed inside the sandbox (needs network: package-registries)
import { copyFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureArtifact, ensurePythonTarget, getTool, imageRef, TOOLCHAIN_DIR } from '../toolchain.mjs';
import { ExecutorError, sandboxPaths, shellQuote } from './common.mjs';

export async function stageTool(manifest, tool, { oci, network, provider, root, fetchImpl, run }) {
  const paths = sandboxPaths(root);
  const optDir = mkdtempSync(join(tmpdir(), 'maxwell-opt-'));
  const cleanup = () => rmSync(optDir, { recursive: true, force: true });
  try {
    if (tool.artifacts && tool.artifacts['linux-amd64']) {
      copyFileSync(await ensureArtifact(tool, { platform: 'linux-amd64', fetchImpl }), join(optDir, tool.name));
      return { optDir, cleanup, image: oci ? imageRef(manifest.baseImages.static) : null, prepare: [`chmod 0755 ${paths.opt}/${tool.name}`], invoke: [`${paths.opt}/${tool.name}`], env: {}, pin: { artifactSha256: tool.artifacts['linux-amd64'].sha256, ...(oci ? { image: imageRef(manifest.baseImages.static) } : {}) } };
    }
    if (tool.python && oci) {
      cpSync(await ensurePythonTarget(manifest, tool, { linuxPlatform: 'linux-amd64', fetchImpl, run }), join(optDir, 'site'), { recursive: true, verbatimSymlinks: true });
      return { optDir, cleanup, image: imageRef(manifest.baseImages.python), prepare: [], invoke: ['python', '-m', tool.python.package], env: { PYTHONPATH: `${paths.opt}/site`, PYTHONDONTWRITEBYTECODE: '1' }, pin: { image: imageRef(manifest.baseImages.python), lockSha256: tool.python.lockSha256 } };
    }
    if (tool.python) {
      if (network !== 'package-registries') throw new ExecutorError('needs-network', `${tool.name} is a Python tool; on ${provider} it is installed inside the sandbox from PyPI with every hash checked, so static.network must be package-registries (or use docker, kubernetes, daytona or modal, which need no network)`);
      copyFileSync(await ensureArtifact(getTool(manifest, 'uv'), { platform: 'linux-amd64', fetchImpl }), join(optDir, 'uv'));
      copyFileSync(join(TOOLCHAIN_DIR, tool.python.lock), join(optDir, 'lock.txt'));
      const uv = `${paths.opt}/uv`;
      return {
        optDir, cleanup, image: null,
        prepare: [
          `chmod 0755 ${uv}`,
          shellQuote([uv, 'venv', '--quiet', '--python', tool.python.pythonVersion, `${root}/venv`]),
          shellQuote([uv, 'pip', 'install', '--quiet', '--require-hashes', '--no-deps', '--python', `${root}/venv/bin/python`, '-r', `${paths.opt}/lock.txt`]),
        ],
        invoke: [`${root}/venv/bin/${tool.name}`], env: {}, prepareEnv: { UV_PYTHON_DOWNLOADS: 'automatic', UV_NO_CONFIG: '1', UV_CACHE_DIR: `${root}/uv-cache` },
        pin: { lockSha256: tool.python.lockSha256, artifactSha256: getTool(manifest, 'uv').artifacts['linux-amd64'].sha256 },
      };
    }
    throw new ExecutorError('no-hosted-source', `${tool.name} has no linux-amd64 artifact or Python lock, so it cannot run on ${provider}`);
  } catch (err) {
    cleanup();
    throw err;
  }
}

// One shell line that runs the tool with a clean environment.
export function toolCommand(staged, argv, envVars) {
  const assignments = Object.entries({ PATH: '/usr/local/bin:/usr/bin:/bin', ...envVars, ...staged.env }).map(([k, v]) => `${k}=${v}`);
  return shellQuote(['env', '-i', ...assignments, ...staged.invoke, ...argv]);
}
