import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProductLifecycle } from '../product-lifecycle/service.mjs';
import { ExportStateStore } from '../feature-runtime/store.mjs';
import { digest, inspectProduct, planRepair, verifyRepair } from '../product-lifecycle/model.mjs';

const revision='a'.repeat(40);
const files=[{path:'package.json',content:'{"name":"example","dependencies":{}}'},
  {path:'response.json',content:'{"headers":{"X-Content-Type-Options":"off"},"message":"hello"}'}];
const check={version:1,type:'json-field-equals',path:'response.json',field:['headers','X-Content-Type-Options'],expected:'nosniff'};
const input={companyId:'example-co',application:'example',environment:'test',revision,check,requestId:'request-0001',session:'owner'};
async function fixture(t, options={}) {
  const root=await mkdtemp(join(tmpdir(),'maxwell-lifecycle-')); t.after(()=>rm(root,{recursive:true,force:true}));
  let config=JSON.parse(files[1].content);
  let deployments=0;
  const server=createServer((_req,res)=>{res.setHeader('X-Content-Type-Options',config.headers['X-Content-Type-Options']);res.end(config.message);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url='http://127.0.0.1:'+server.address().port;
  const service=new ProductLifecycle({store:new ExportStateStore({root,sessionId:'ses_lifecycle123'}),
    authorize:async(session,companyId,permission)=>session==='owner' || (session==='reader' && permission==='product.read') ? {id:session,companyId} : null,
    load:async()=>structuredClone(files),
    verifyRuntime:async op=>{
      const res=await fetch(url); const body=await res.text();
      if(op.phase==='before') return {outcome:res.headers.get('x-content-type-options')==='off'?'reproduced':'inconclusive',revision};
      return {outcome: !options.fail && res.headers.get('x-content-type-options')==='nosniff' && body==='hello'?'passed':'failed',candidateSha256:op.plan.candidateSha256};
    },
    deploy:async op=>{config=JSON.parse(op.plan.candidate);deployments++;return {candidateSha256:op.plan.candidateSha256};},
    recover:async()=>{if(options.rollbackFail) throw new Error('unavailable');config=JSON.parse(files[1].content);return {outcome:'restored',revision};}
  });
  return {service,url,deployments:()=>deployments};
}
test('prepare, actual HTTP recovery, replay and tenant authorization',async t=>{
  const f=await fixture(t);
  const run=await f.service.start(input);
  assert.equal(run.value.state,'prepared');
  assert.equal(run.value.plan.diagnosis.operationalCause,'unconfirmed');
  assert.equal((await f.service.start(input)).revision,1);
  await assert.rejects(f.service.start({...input,revision:'b'.repeat(40)}),/reused/);
  await assert.rejects(f.service.release({...input,id:run.key,expectedRevision:1,session:'reader'}),/authorized/);
  const attempts=await Promise.allSettled([1,2].map(()=>f.service.release({...input,id:run.key,expectedRevision:1})));
  assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
  assert.equal(f.deployments(),1);
  const done=await f.service.read({...input,id:run.key});
  assert.equal(done.value.state,'recovered');
  const res=await fetch(f.url);assert.equal(res.headers.get('x-content-type-options'),'nosniff');
  assert.equal(await res.text(),'hello');
  await assert.rejects(f.service.read({...input,companyId:'other',id:run.key}),/unavailable/);
});
test('failed recovery restores original behavior and failed rollback stays unresolved',async t=>{
  for(const rollbackFail of [false,true]){
    const f=await fixture(t,{fail:true,rollbackFail});
    const run=await f.service.start(input);
    const done=await f.service.release({...input,id:run.key,expectedRevision:1});
    assert.equal(done.value.state,rollbackFail?'needs-intervention':'rolled-back');
    if(!rollbackFail)assert.equal((await fetch(f.url)).headers.get('x-content-type-options'),'off');
  }
});
test('rejects traversal, unsupported edits, duplicate source and unrelated patch changes',()=>{
  const model=inspectProduct({...input,files});
  const plan=planRepair(model,check);
  assert.equal(verifyRepair(model,plan).outcome,'passed');
  assert.throws(()=>inspectProduct({...input,files:[{path:'../config',content:'x'}]}));
  assert.throws(()=>inspectProduct({...input,files:[files[0],files[0]]}));
  assert.throws(()=>planRepair(model,{...check,field:['__proto__','x']}));
  const bad={...plan,candidate:'{"headers":{"X-Content-Type-Options":"nosniff"},"message":"broken"}'};
  assert.throws(()=>verifyRepair(model,bad),/provenance/);
});
test('inconclusive baseline never deploys or rolls back; cancellation prevents release',async t=>{
  const f=await fixture(t);
  const run=await f.service.start(input);
  let touched=0;
  f.service.verifyRuntime=async()=>({outcome:'inconclusive'});
  f.service.recover=async()=>{touched++;};
  const done=await f.service.release({...input,id:run.key,expectedRevision:1});
  assert.equal(done.value.state,'inconclusive');
  assert.equal(touched,0);assert.equal(f.deployments(),0);
  const second=await f.service.start({...input,requestId:'request-0002'});
  await f.service.cancel({...input,id:second.key,expectedRevision:1});
  await assert.rejects(f.service.release({...input,id:second.key,expectedRevision:1}));
});
test('repair verification detects unrelated changes even when candidate digest is recomputed',()=>{
  const model=inspectProduct({...input,files});
  const plan=planRepair(model,check);
  const bad={...plan,candidate:'{"headers":{"X-Content-Type-Options":"nosniff"},"message":"broken"}'};
  // The independent expected-document comparison must still catch this.
  bad.candidateSha256=digest(bad.candidate);
  assert.throws(()=>verifyRepair(model,bad),/unrelated/);
});
