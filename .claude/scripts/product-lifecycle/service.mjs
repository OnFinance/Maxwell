import { actor, timestamp, requireValue } from '../feature-runtime/store.mjs';
import { digest, inspectProduct, planRepair, verifyRepair } from './model.mjs';

// load, verifyRuntime, deploy and recover are host-owned adapters, never commands from a request.
export class ProductLifecycle {
  constructor({ store, authorize, load, verifyRuntime, deploy, recover, clock = Date.now }) {
    requireValue(store && typeof authorize === 'function' && typeof load === 'function', 'Lifecycle adapters required.');
    Object.assign(this, {store, authorize, load, verifyRuntime, deploy, recover, clock});
  }
  async start({session, companyId, requestId, application, environment, revision, check, signals}) {
    const by = await actor(this.authorize, session, companyId, 'product.prepare');
    requireValue(typeof requestId === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(requestId), 'A stable request ID is required.');
    const id = 'product_' + digest([application, environment, requestId]);
    const identity = digest({application,environment,revision,check,signals:signals ?? []});
    const existing = await this.store.get(companyId,id);
    if (existing) { requireValue(existing.value.inputHash === identity, 'Request ID reused with different inputs.'); return existing; }
    const files = await this.load({companyId, application, environment, revision});
    const model = inspectProduct({files,application,environment,revision});
    const plan = planRepair(model,check,signals);
    const verification = verifyRepair(model,plan);
    return this.store.change(companyId,id,null,{id,kind:'maxwell.product.lifecycle',application,environment,revision,
      inputHash:identity,createdBy:by,state:plan.needsRepair ? 'prepared' : 'no-change',createdAt:timestamp(this.clock()),
      // Persist only the selected repair preimage, not the rest of a potentially sensitive codebase.
      model:{...model,sources:model.sources.map(s=>({path:s.path,sha256:s.sha256}))},
      plan,verification,history:[{state:'prepared',actor:by,at:timestamp(this.clock())}]},this.clock());
  }
  async read({session,companyId,id}) {
    await actor(this.authorize,session,companyId,'product.read');
    const current = await this.store.get(companyId,id);
    requireValue(current,'Run unavailable.'); return current;
  }
  async cancel({session,companyId,id,expectedRevision}) {
    const by = await actor(this.authorize,session,companyId,'product.prepare');
    const current = await this.store.get(companyId,id);
    requireValue(current?.revision === expectedRevision && current.value.state === 'prepared','Only a prepared run can be cancelled.');
    return this.store.change(companyId,id,current,{...current.value,state:'cancelled',
      history:[...current.value.history,{state:'cancelled',actor:by,at:timestamp(this.clock())}]},this.clock());
  }
  async release({session,companyId,id,expectedRevision}) {
    const by = await actor(this.authorize,session,companyId,'product.release');
    const current = await this.store.get(companyId,id);
    requireValue(current && current.revision === expectedRevision && current.value.state === 'prepared', 'Run changed or is not prepared.');
    requireValue(this.verifyRuntime && this.deploy && this.recover,'A trusted deployment adapter and runtime verifier are required.');
    const run = current.value;
    requireValue(!['prod','production'].includes(run.environment),'Production release is not supported by this initial profile.');
    // Re-read source and environment binding immediately before starting external effects.
    const files = await this.load({companyId,application:run.application,environment:run.environment,revision:run.revision});
    const source = files.find(f=>f.path===run.plan.path);
    requireValue(source && digest(source.content)===run.plan.sourceSha256,'Source changed since preparation.');
    const claimed = await this.store.change(companyId,id,current,{...run,state:'releasing',
      history:[...run.history,{state:'releasing',actor:by,at:timestamp(this.clock())}]},this.clock());
    return this.finishRelease(companyId,id,claimed,by);
  }
  async resume({session,companyId,id,expectedRevision}) {
    const by = await actor(this.authorize,session,companyId,'product.release');
    const current = await this.store.get(companyId,id);
    requireValue(current?.revision === expectedRevision && current.value.state === 'releasing','Run is not awaiting recovery.');
    requireValue(this.deploy && this.verifyRuntime && this.recover,'Deployment adapters unavailable.');
    return this.finishRelease(companyId,id,current,by);
  }
  async finishRelease(companyId,id,current,by) {
    const run = current.value;
    // Adapters must serialize effects for this operation key and be idempotent for this operation key and report the active candidate digest.
    const operation = {companyId,id,operationId:id,application:run.application,environment:run.environment,
      baseRevision:run.revision,plan:run.plan};
    let state, result;
    let deploymentAttempted = false;
    try {
      const baseline = run.baseline ?? await this.verifyRuntime({...operation,phase:'before'});
      requireValue(baseline?.outcome === 'reproduced' && baseline.revision === run.revision,'Original behavior could not be reproduced.');
      if (!run.baseline) {
        current = await this.store.change(companyId,id,current,{...run,baseline},this.clock());
        run.baseline = baseline;
      }
      deploymentAttempted = true;
      const deployment = await this.deploy(operation);
      requireValue(deployment?.candidateSha256 === run.plan.candidateSha256,'Deployment identity mismatch.');
      const recovery = await this.verifyRuntime({...operation,phase:'after'});
      requireValue(recovery?.outcome === 'passed' && recovery.candidateSha256 === run.plan.candidateSha256,'Recovery not verified.');
      state='recovered'; result={baseline,deployment,recovery};
    } catch {
      if (!deploymentAttempted) {
        return this.store.change(companyId,id,current,{...run,state:'inconclusive',
          result:{reason:'The original behavior was not reproduced; no deployment was attempted.'},
          history:[...run.history,{state:'inconclusive',actor:by,at:timestamp(this.clock())}]},this.clock());
      }
      try {
        const rollback=await this.recover(operation);
        requireValue(rollback?.outcome==='restored' && rollback.revision===run.revision,'Rollback unverified.');
        state='rolled-back'; result={reason:'Release or verification failed.',rollback};
      } catch { state='needs-intervention'; result={reason:'Release or verification failed and restoration was not verified.'}; }
    }
    return this.store.change(companyId,id,current,{...run,state,result,
      history:[...run.history,{state,actor:by,at:timestamp(this.clock())}]},this.clock());
  }
}
