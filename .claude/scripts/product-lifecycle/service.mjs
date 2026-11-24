import { actor, timestamp, requireValue } from '../feature-runtime/store.mjs';
import { digest, inspectProduct, planRepair, verifyRepair } from './model.mjs';
import { bindFinding } from './finding.mjs';

// load, verifyRuntime, deploy and recover are host-owned adapters, never commands from a request.
export class ProductLifecycle {
  constructor({
    store,
    authorize,
    load,
    loadFinding,
    resolveEnvironment,
    remediation,
    verifyRuntime,
    deploy,
    recover,
    clock = Date.now,
  }) {
    requireValue(
      store && typeof authorize === 'function' && typeof load === 'function',
      'Lifecycle adapters required.',
    );
    Object.assign(this, {
      store,
      authorize,
      load,
      loadFinding,
      resolveEnvironment,
      remediation,
      verifyRuntime,
      deploy,
      recover,
      clock,
    });
  }
  async start({
    session,
    companyId,
    requestId,
    application,
    environment,
    revision,
    check,
    signals,
    repository,
    findingId,
  }) {
    const by = await actor(this.authorize, session, companyId, 'product.prepare');
    requireValue(
      typeof requestId === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(requestId),
      'A stable request ID is required.',
    );
    const id = 'product_' + digest([application, environment, requestId]);
    if (repository !== undefined)
      requireValue(/^[a-z0-9][a-z0-9-]{0,63}$/.test(repository), 'Invalid repository.');
    const identity = digest({
      application,
      environment,
      revision,
      check,
      signals: signals ?? [],
      ...(repository !== undefined ? { repository } : {}),
      ...(findingId !== undefined ? { findingId } : {}),
    });
    const existing = await this.store.get(companyId, id);
    if (existing) {
      requireValue(
        existing.value.inputHash === identity,
        'Request ID reused with different inputs.',
      );
      return existing;
    }
    const files = await this.load({ companyId, application, repository, environment, revision });
    const model = inspectProduct({ files, application, environment, revision });
    const plan = planRepair(model, check, signals);
    const verification = verifyRepair(model, plan);
    let finding;
    if (findingId !== undefined) {
      requireValue(typeof this.loadFinding === 'function', 'A ledger finding adapter is required.');
      finding = bindFinding(await this.loadFinding({ companyId, findingId }), {
        companyId,
        application,
        repository,
        environment,
        check,
      });
      requireValue(finding.findingId === findingId, 'Finding identity mismatch.');
    }
    return this.store.change(
      companyId,
      id,
      null,
      {
        id,
        kind: 'maxwell.product.lifecycle',
        ...(repository !== undefined ? { repository } : {}),
        ...(finding ? { finding } : {}),
        application,
        environment,
        revision,
        inputHash: identity,
        createdBy: by,
        state: plan.needsRepair ? 'prepared' : 'no-change',
        createdAt: timestamp(this.clock()),
        // Persist only the selected repair preimage, not the rest of a potentially sensitive codebase.
        model: {
          ...model,
          sources: model.sources.map((s) => ({ path: s.path, sha256: s.sha256 })),
        },
        plan,
        verification,
        history: [
          {
            state: plan.needsRepair ? 'prepared' : 'no-change',
            actor: by,
            at: timestamp(this.clock()),
          },
        ],
      },
      this.clock(),
    );
  }
  async read({ session, companyId, id }) {
    await actor(this.authorize, session, companyId, 'product.read');
    const current = await this.store.get(companyId, id);
    requireValue(current, 'Run unavailable.');
    return current;
  }
  async cancel({ session, companyId, id, expectedRevision }) {
    const by = await actor(this.authorize, session, companyId, 'product.prepare');
    const current = await this.store.get(companyId, id);
    requireValue(
      current?.revision === expectedRevision && current.value.state === 'prepared',
      'Only a prepared run can be cancelled.',
    );
    return this.store.change(
      companyId,
      id,
      current,
      {
        ...current.value,
        state: 'cancelled',
        history: [
          ...current.value.history,
          { state: 'cancelled', actor: by, at: timestamp(this.clock()) },
        ],
      },
      this.clock(),
    );
  }
  async release({ session, companyId, id, expectedRevision }) {
    const by = await actor(this.authorize, session, companyId, 'product.release');
    const current = await this.store.get(companyId, id);
    requireValue(
      current && current.revision === expectedRevision && current.value.state === 'prepared',
      'Run changed or is not prepared.',
    );
    requireValue(
      this.verifyRuntime && this.deploy && this.recover,
      'A trusted deployment adapter and runtime verifier are required.',
    );
    const run = current.value;
    const environmentTier = await this.releaseEnvironment(companyId, run);
    await this.currentFinding(companyId, run);
    // Re-read source and environment binding immediately before starting external effects.
    const files = await this.load({
      companyId,
      application: run.application,
      repository: run.repository,
      environment: run.environment,
      revision: run.revision,
    });
    const source = files.find((f) => f.path === run.plan.path);
    requireValue(
      source && digest(source.content) === run.plan.sourceSha256,
      'Source changed since preparation.',
    );
    const claimed = await this.store.change(
      companyId,
      id,
      current,
      {
        ...run,
        state: 'releasing',
        environmentTier,
        history: [...run.history, { state: 'releasing', actor: by, at: timestamp(this.clock()) }],
      },
      this.clock(),
    );
    return this.finishRelease(companyId, id, claimed, by);
  }
  async resume({ session, companyId, id, expectedRevision }) {
    const by = await actor(this.authorize, session, companyId, 'product.release');
    const current = await this.store.get(companyId, id);
    requireValue(
      current?.revision === expectedRevision && current.value.state === 'releasing',
      'Run is not awaiting recovery.',
    );
    requireValue(
      this.deploy && this.verifyRuntime && this.recover,
      'Deployment adapters unavailable.',
    );
    const tier = await this.releaseEnvironment(companyId, current.value);
    requireValue(tier === current.value.environmentTier, 'Environment classification changed.');
    await this.currentFinding(companyId, current.value);
    return this.finishRelease(companyId, id, current, by);
  }
  async releaseEnvironment(companyId, run) {
    requireValue(
      typeof this.resolveEnvironment === 'function',
      'A trusted environment policy adapter is required.',
    );
    const metadata = await this.resolveEnvironment({
      companyId,
      application: run.application,
      repository: run.repository,
      environment: run.environment,
    });
    requireValue(
      ['dev', 'test', 'devtest', 'sandbox', 'preview', 'qa', 'uat', 'staging'].includes(
        metadata?.tier,
      ),
      'Release requires a registered non-production environment.',
    );
    return metadata.tier;
  }
  async currentFinding(companyId, run) {
    if (!run.finding) return;
    requireValue(typeof this.loadFinding === 'function', 'Finding adapter unavailable.');
    const current = await this.loadFinding({ companyId, findingId: run.finding.findingId });
    requireValue(digest(current) === run.finding.signature, 'Finding changed since preparation.');
  }
  async requestVerification({ session, companyId, id, expectedRevision, initiativeId, taskId }) {
    await actor(this.authorize, session, companyId, 'product.prepare');
    const current = await this.store.get(companyId, id);
    requireValue(
      current?.revision === expectedRevision &&
        ['recovered', 'verification-requested'].includes(current.value.state),
      'Only a recovered repair can enter remediation verification.',
    );
    const run = current.value;
    requireValue(
      run.finding && this.remediation,
      'A linked finding and remediation service are required.',
    );
    const candidateRevision = run.result?.deployment?.revision;
    requireValue(
      /^[a-f0-9]{40}$/.test(candidateRevision ?? ''),
      'The deployed candidate commit is required.',
    );
    if (run.state === 'verification-requested') {
      requireValue(
        run.verificationRequest.initiativeId === initiativeId &&
          run.verificationRequest.taskId === taskId,
        'Verification task changed.',
      );
      return current;
    }
    await this.currentFinding(companyId, run);
    const verification = await this.remediation.open({
      session,
      companyId,
      findingId: run.finding.findingId,
      initiativeId,
      taskId,
      check: run.plan.check,
      revision: candidateRevision,
      requestId: run.id.slice('product_'.length),
    });
    return this.store.change(
      companyId,
      id,
      current,
      {
        ...run,
        state: 'verification-requested',
        verificationRequest: {
          id: verification.value.id,
          initiativeId,
          taskId,
          criteriaHash: verification.value.criteriaHash,
        },
        history: [
          ...run.history,
          {
            state: 'verification-requested',
            actor: verification.value.requestedBy,
            at: timestamp(this.clock()),
          },
        ],
      },
      this.clock(),
    );
  }
  async finishRelease(companyId, id, current, by) {
    const run = current.value;
    // Adapters must serialize effects for this operation key and be idempotent for this operation key and report the active candidate digest.
    const operation = {
      companyId,
      id,
      operationId: id,
      application: run.application,
      repository: run.repository,
      environment: run.environment,
      baseRevision: run.revision,
      plan: run.plan,
    };
    let state, result;
    let deploymentAttempted = false;
    try {
      const baseline =
        run.baseline ?? (await this.verifyRuntime({ ...operation, phase: 'before' }));
      requireValue(
        baseline?.outcome === 'reproduced' && baseline.revision === run.revision,
        'Original behavior could not be reproduced.',
      );
      if (!run.baseline) {
        current = await this.store.change(
          companyId,
          id,
          current,
          { ...run, baseline },
          this.clock(),
        );
        run.baseline = baseline;
      }
      deploymentAttempted = true;
      const deployment = await this.deploy(operation);
      requireValue(
        deployment?.candidateSha256 === run.plan.candidateSha256,
        'Deployment identity mismatch.',
      );
      const recovery = await this.verifyRuntime({ ...operation, phase: 'after' });
      requireValue(
        recovery?.outcome === 'passed' && recovery.candidateSha256 === run.plan.candidateSha256,
        'Recovery not verified.',
      );
      state = 'recovered';
      result = { baseline, deployment, recovery };
    } catch {
      if (!deploymentAttempted) {
        return this.store.change(
          companyId,
          id,
          current,
          {
            ...run,
            state: 'inconclusive',
            result: {
              reason: 'The original behavior was not reproduced; no deployment was attempted.',
            },
            history: [
              ...run.history,
              { state: 'inconclusive', actor: by, at: timestamp(this.clock()) },
            ],
          },
          this.clock(),
        );
      }
      try {
        const rollback = await this.recover(operation);
        requireValue(
          rollback?.outcome === 'restored' && rollback.revision === run.revision,
          'Rollback unverified.',
        );
        state = 'rolled-back';
        result = { reason: 'Release or verification failed.', rollback };
      } catch {
        state = 'needs-intervention';
        result = { reason: 'Release or verification failed and restoration was not verified.' };
      }
    }
    return this.store.change(
      companyId,
      id,
      current,
      {
        ...run,
        state,
        result,
        history: [...run.history, { state, actor: by, at: timestamp(this.clock()) }],
      },
      this.clock(),
    );
  }
}
