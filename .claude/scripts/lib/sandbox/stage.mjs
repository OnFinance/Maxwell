// Prepares a pinned tool for a hosted sandbox. Hosted providers start from a pinned base image (Daytona, Modal, the
// Lambda MicroVMs runner) or from their own default image (E2B, Vercel Sandbox), so the tool travels in the upload
// bundle, built for the sandbox's platform (linux-amd64, or linux-arm64 on Lambda MicroVMs):
//   binary  the checksum-verified release binary
//   site    hash-locked wheels installed for the platform on this machine, run with the pinned Python base image or the
//           runner's own Python (sitePython)
//   uv      the verified uv binary and the lock, installed inside the sandbox (needs network: package-registries)
import { copyFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureArtifact, ensurePythonTarget, getTool, imageRef, TOOLCHAIN_DIR } from '../toolchain.mjs';
import { ExecutorError, sandboxPaths, shellQuote } from './common.mjs';

export async function stageTool(manifest, tool, { oci, network, provider, root, fetchImpl, run, platform = 'linux-amd64', sitePython = null }) {
  const paths = sandboxPaths(root);
  const optDir = mkdtempSync(join(tmpdir(), 'maxwell-opt-'));
  const cleanup = () => rmSync(optDir, { recursive: true, force: true });
  try {
    if (tool.artifacts && tool.artifacts[platform]) {
      copyFileSync(await ensureArtifact(tool, { platform, fetchImpl }), join(optDir, tool.name));
      return { optDir, cleanup, image: oci ? imageRef(manifest.baseImages.static) : null, prepare: [`chmod 0755 ${paths.opt}/${tool.name}`], invoke: [`${paths.opt}/${tool.name}`], env: {}, pin: { artifactSha256: tool.artifacts[platform].sha256, ...(oci ? { image: imageRef(manifest.baseImages.static) } : {}) } };
    }
    if (tool.python && (oci || sitePython)) {
      if (!oci && sitePython !== tool.python.pythonVersion) throw new ExecutorError('no-hosted-source', `${tool.name} is locked for Python ${tool.python.pythonVersion}, but the ${provider} runner has Python ${sitePython}`);
      cpSync(await ensurePythonTarget(manifest, tool, { linuxPlatform: platform, fetchImpl, run }), join(optDir, 'site'), { recursive: true, verbatimSymlinks: true });
      const image = oci ? imageRef(manifest.baseImages.python) : null;
      return { optDir, cleanup, image, prepare: [], invoke: [oci ? 'python' : `python${sitePython}`, '-m', tool.python.package], env: { PYTHONPATH: `${paths.opt}/site`, PYTHONDONTWRITEBYTECODE: '1' }, pin: { ...(image ? { image } : {}), lockSha256: tool.python.lockSha256 } };
    }
    if (tool.python) {
      if (network !== 'package-registries') throw new ExecutorError('needs-network', `${tool.name} is a Python tool; on ${provider} it is installed inside the sandbox from PyPI with every hash checked, so static.network must be package-registries (or use docker, kubernetes, daytona, modal or lambda-microvms, which need no network)`);
      copyFileSync(await ensureArtifact(getTool(manifest, 'uv'), { platform, fetchImpl }), join(optDir, 'uv'));
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
        pin: { lockSha256: tool.python.lockSha256, artifactSha256: getTool(manifest, 'uv').artifacts[platform].sha256 },
      };
    }
    throw new ExecutorError('no-hosted-source', `${tool.name} has no ${platform} artifact or Python lock, so it cannot run on ${provider}`);
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
