// kubernetes: runs each scan as a short-lived, non-root pod in Maxwell's own executor cluster (not a target cluster),
// driven by the pinned kubectl. The pod has three containers sharing one emptyDir:
//   upload (init)    pinned base image, waits until the bundle is streamed in with kubectl exec
//   version (init)   the tool image printing its version, checked before any result is trusted
//   tool             the digest-pinned tool image; checkout read-only, only /work/out writable
//   collector        pinned base image that stays up so the result can be read back, then the pod is deleted
// Egress is expected to be blocked by a default-deny NetworkPolicy in the namespace; connect.mjs checks for one.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureArtifact, ensureHostTool, ensurePythonTarget, getTool, imageRef, versionMatches } from '../../toolchain.mjs';
import { ExecutorError, IN_SANDBOX, clip, packBundle, scannerEnv, substitute } from '../common.mjs';

const securityContext = { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] }, seccompProfile: { type: 'RuntimeDefault' } };

export function scanPod({ name, namespace, plan, argv, versionArgs, limits, cfg, labels = {} }) {
  const base = imageRef(plan.baseImage);
  const env = Object.entries({ ...scannerEnv(), ...plan.env }).map(([k, v]) => ({ name: k, value: String(v) }));
  const res = { requests: { cpu: String(limits.cpu), memory: `${limits.memoryMb}Mi` }, limits: { cpu: String(limits.cpu), memory: `${limits.memoryMb}Mi` } };
  const small = { requests: { cpu: '100m', memory: '64Mi' }, limits: { cpu: '500m', memory: '256Mi' } };
  const tmp = { name: 'tmp', mountPath: '/tmp' };
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name, namespace, labels: { 'app.kubernetes.io/managed-by': 'maxwell', 'maxwell.onfinance.ai/role': 'scan', ...labels } },
    spec: {
      restartPolicy: 'Never', activeDeadlineSeconds: limits.timeoutSeconds + 300, automountServiceAccountToken: false, enableServiceLinks: false,
      ...(cfg.serviceAccount ? { serviceAccountName: cfg.serviceAccount } : {}), ...(cfg.nodeSelector ? { nodeSelector: cfg.nodeSelector } : {}),
      ...(cfg.imagePullSecret ? { imagePullSecrets: [{ name: cfg.imagePullSecret }] } : {}),
      securityContext: { fsGroup: 65532, runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
      volumes: [{ name: 'work', emptyDir: { sizeLimit: '4Gi' } }, { name: 'tmp', emptyDir: { sizeLimit: '2Gi' } }],
      initContainers: [
        { name: 'upload', image: base, command: ['/bin/sh', '-c', 'until [ -f /work/.ready ]; do sleep 1; done'], securityContext, resources: small, volumeMounts: [{ name: 'work', mountPath: '/work' }, tmp] },
        { name: 'version', image: plan.image, command: [plan.invoke], args: [...(plan.prefixArgs || []), ...versionArgs], env, securityContext, resources: small, volumeMounts: [{ name: 'work', mountPath: IN_SANDBOX.opt, subPath: 'opt', readOnly: true }, tmp] },
      ],
      containers: [
        { name: 'tool', image: plan.image, command: [plan.invoke], args: [...(plan.prefixArgs || []), ...argv], env, securityContext, resources: res, workingDir: '/tmp',
          volumeMounts: [{ name: 'work', mountPath: IN_SANDBOX.src, subPath: 'src', readOnly: true }, { name: 'work', mountPath: '/work/out', subPath: 'out' }, { name: 'work', mountPath: IN_SANDBOX.opt, subPath: 'opt', readOnly: true }, tmp] },
        { name: 'collector', image: base, command: ['/bin/sh', '-c', 'sleep 3600'], securityContext, resources: small, volumeMounts: [{ name: 'work', mountPath: '/work/out', subPath: 'out', readOnly: true }, tmp] },
      ],
    },
  };
}

// Where a tool's binary comes from in the pod: its own image, or the base image with the verified binary uploaded.
export function podPlan(manifest, tool) {
  if (tool.image) return { image: imageRef(tool.image), invoke: tool.image.invoke, env: {}, baseImage: manifest.baseImages.static, upload: null, pin: { image: imageRef(tool.image) } };
  if (tool.artifacts && tool.artifacts['linux-amd64']) return { image: imageRef(manifest.baseImages.static), invoke: `${IN_SANDBOX.opt}/${tool.name}`, env: {}, baseImage: manifest.baseImages.static, upload: 'binary', pin: { image: imageRef(manifest.baseImages.static), artifactSha256: tool.artifacts['linux-amd64'].sha256 } };
  if (tool.python) return { image: imageRef(manifest.baseImages.python), invoke: 'python', prefixArgs: ['-m', tool.python.package], env: { PYTHONPATH: `${IN_SANDBOX.opt}/site` }, baseImage: manifest.baseImages.static, upload: 'python', pin: { image: imageRef(manifest.baseImages.python), lockSha256: tool.python.lockSha256 } };
  throw new ExecutorError('no-container-source', `${tool.name} has no image, linux artifact or Python lock`);
}

function kubectlRunner(bin, cfg, run) {
  const kubeconfig = process.env[cfg.kubeconfigEnv];
  if (!kubeconfig) throw new ExecutorError('not-configured', `${cfg.kubeconfigEnv} is not set: it must hold the path to the executor cluster's kubeconfig`);
  const base = ['--kubeconfig', kubeconfig, ...(cfg.context ? ['--context', cfg.context] : []), '-n', cfg.namespace];
  return (args, opts = {}) => run(bin, [...base, ...args], { encoding: opts.input && Buffer.isBuffer(opts.input) ? 'buffer' : 'utf8', timeout: 600000, maxBuffer: 256 << 20, ...opts });
}

const text = (r) => (Buffer.isBuffer(r.stdout) ? r.stdout.toString('utf8') : r.stdout || '');

async function waitFor(kubectl, name, predicate, { timeoutMs, sleep }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = kubectl(['get', 'pod', name, '-o', 'json']);
    if (r.status === 0) {
      const pod = JSON.parse(text(r));
      const verdict = predicate(pod);
      if (verdict) return { pod, verdict };
    }
    if (Date.now() > deadline) throw new ExecutorError('timeout', `pod ${name} did not reach the expected state in time`);
    await sleep(2000);
  }
}

export async function runTool({ manifest, tool, argv, repoDir, resultPath, limits, providerConfig, deps = {} }) {
  const run = deps.run || spawnSync;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const { path: kubectlBin } = await ensureHostTool(manifest, 'kubectl', { fetchImpl: deps.fetchImpl, run });
  const kubectl = kubectlRunner(kubectlBin, providerConfig, run);
  const plan = podPlan(manifest, tool);
  const name = `maxwell-scan-${tool.name}-${(deps.id || Math.random().toString(36).slice(2, 10)).toLowerCase()}`.slice(0, 63);
  const staging = mkdtempSync(join(tmpdir(), 'maxwell-bundle-'));
  try {
    const pod = scanPod({ name, namespace: providerConfig.namespace, plan, argv: substitute(argv, IN_SANDBOX), versionArgs: tool.versionCheck.args, limits, cfg: providerConfig });
    const created = kubectl(['create', '-f', '-', '-o', 'name'], { input: JSON.stringify(pod) });
    if (created.status !== 0) throw new ExecutorError('create-failed', `creating pod ${name} failed: ${clip(created.stderr, 400)}`);
    try {
      await waitFor(kubectl, name, (p) => (p.status.initContainerStatuses || []).some((s) => s.name === 'upload' && s.state && s.state.running), { timeoutMs: 300000, sleep });
      let optDir;
      if (plan.upload) {
        optDir = join(staging, 'opt');
        mkdirSync(optDir);
        if (plan.upload === 'binary') copyFileSync(await ensureArtifact(tool, { platform: 'linux-amd64', fetchImpl: deps.fetchImpl }), join(optDir, tool.name));
        else cpSync(await ensurePythonTarget(manifest, tool, { linuxPlatform: 'linux-amd64', fetchImpl: deps.fetchImpl, run }), join(optDir, 'site'), { recursive: true, verbatimSymlinks: true });
      }
      const bundle = packBundle(repoDir, join(staging, 'bundle.tgz'), { optDir, run });
      const up = kubectl(['exec', '-i', name, '-c', 'upload', '--', '/bin/sh', '-c', 'mkdir -p /work/out && chmod 0777 /work/out && tar -xzf - -C /work && touch /work/.ready'], { input: readFileSync(bundle) });
      if (up.status !== 0) throw new ExecutorError('upload-failed', `upload to ${name} failed: ${clip(up.stderr, 400)}`);
      const { pod: done } = await waitFor(kubectl, name, (p) => {
        const s = (p.status.containerStatuses || []).find((c) => c.name === 'tool');
        return s && s.state && s.state.terminated ? s.state.terminated : null;
      }, { timeoutMs: limits.timeoutSeconds * 1000 + 300000, sleep });
      const versionOutput = text(kubectl(['logs', name, '-c', 'version'])).trim();
      if (!versionMatches(tool, versionOutput)) throw new ExecutorError('version-mismatch', `${tool.name} in ${plan.image} printed "${versionOutput.split('\n')[0].slice(0, 160)}", expected ${tool.version}`);
      const exitCode = done.status.containerStatuses.find((c) => c.name === 'tool').state.terminated.exitCode;
      const logs = text(kubectl(['logs', name, '-c', 'tool']));
      const out = kubectl(['exec', name, '-c', 'collector', '--', 'cat', '/work/out/result'], { encoding: 'buffer' });
      if (out.status === 0) writeFileSync(resultPath, out.stdout);
      return { exitCode, timedOut: false, stdout: logs, stderr: '', provenance: { provider: 'kubernetes', isolation: 'pod', namespace: providerConfig.namespace, toolVersion: tool.version, versionOutput: versionOutput.split('\n')[0], ...plan.pin } };
    } finally {
      kubectl(['delete', 'pod', name, '--wait=false', '--ignore-not-found']);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function commandPod({ name, namespace, image, invoke, args, secretName, cfg, timeoutSeconds }) {
  return {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name, namespace, labels: { 'app.kubernetes.io/managed-by': 'maxwell', 'maxwell.onfinance.ai/role': 'probe' } },
    spec: {
      restartPolicy: 'Never', activeDeadlineSeconds: timeoutSeconds + 60, automountServiceAccountToken: false, enableServiceLinks: false,
      ...(cfg.serviceAccount ? { serviceAccountName: cfg.serviceAccount } : {}), ...(cfg.nodeSelector ? { nodeSelector: cfg.nodeSelector } : {}),
      securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532, seccompProfile: { type: 'RuntimeDefault' } },
      volumes: [{ name: 'tmp', emptyDir: {} }, ...(secretName ? [{ name: 'creds', secret: { secretName, defaultMode: 0o440 } }] : [])],
      containers: [{
        name: 'probe', image, command: [invoke], args, env: [{ name: 'HOME', value: '/tmp' }],
        securityContext, resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '512Mi' } },
        volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }, ...(secretName ? [{ name: 'creds', mountPath: '/run/maxwell', readOnly: true }] : [])],
      }],
    },
  };
}

// Runtime commands: the CLI's pinned image in a pod; credential files travel in a Secret that lives only as long as
// the pod. Environment variables for the CLI point at the mounted files (for example KUBECONFIG=/run/maxwell/kubeconfig).
export async function runCommand({ manifest, argv, env = {}, files = {}, timeoutSeconds, providerConfig, deps = {} }) {
  const run = deps.run || spawnSync;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const tool = getTool(manifest, argv[0]);
  if (!tool.image) throw new ExecutorError('no-image', `${argv[0]} has no pinned image`);
  const { path: kubectlBin } = await ensureHostTool(manifest, 'kubectl', { fetchImpl: deps.fetchImpl, run });
  const kubectl = kubectlRunner(kubectlBin, providerConfig, run);
  const id = (deps.id || Math.random().toString(36).slice(2, 10)).toLowerCase();
  const name = `maxwell-probe-${argv[0]}-${id}`.slice(0, 63);
  const secretName = Object.keys(files).length ? `${name}-creds`.slice(0, 63) : null;
  const pod = commandPod({ name, namespace: providerConfig.namespace, image: imageRef(tool.image), invoke: tool.image.invoke, args: argv.slice(1), secretName, cfg: providerConfig, timeoutSeconds });
  pod.spec.containers[0].env.push(...Object.entries(env).map(([k, v]) => ({ name: k, value: String(v) })));
  try {
    if (secretName) {
      const secret = { apiVersion: 'v1', kind: 'Secret', type: 'Opaque', metadata: { name: secretName, namespace: providerConfig.namespace, labels: { 'app.kubernetes.io/managed-by': 'maxwell' } }, data: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v).toString('base64')])) };
      const s = kubectl(['create', '-f', '-', '-o', 'name'], { input: JSON.stringify(secret) });
      if (s.status !== 0) throw new ExecutorError('create-failed', `creating the credential secret failed: ${clip(s.stderr, 300)}`);
    }
    const c = kubectl(['create', '-f', '-', '-o', 'name'], { input: JSON.stringify(pod) });
    if (c.status !== 0) throw new ExecutorError('create-failed', `creating pod ${name} failed: ${clip(c.stderr, 300)}`);
    const { verdict } = await waitFor(kubectl, name, (p) => {
      const st = (p.status.containerStatuses || [])[0];
      return st && st.state && st.state.terminated ? st.state.terminated : null;
    }, { timeoutMs: timeoutSeconds * 1000 + 120000, sleep });
    const logs = kubectl(['logs', name, '-c', 'probe']);
    return { exitCode: verdict.exitCode, timedOut: verdict.reason === 'DeadlineExceeded', stdout: text(logs), stderr: '', provenance: { provider: 'kubernetes', isolation: 'pod', pinned: true, image: imageRef(tool.image) } };
  } finally {
    kubectl(['delete', 'pod', name, '--wait=false', '--ignore-not-found']);
    if (secretName) kubectl(['delete', 'secret', secretName, '--ignore-not-found']);
  }
}
