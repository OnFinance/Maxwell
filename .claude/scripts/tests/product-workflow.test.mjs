import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source=await readFile('.claude/workflows/investigate-product.js','utf8');
const body=source.replace('export const meta','const meta');
const execute=new (Object.getPrototypeOf(async function(){}).constructor)('args','agent','phase',body);
test('investigation normal entry point calls source, SRE and independent reviewers without writes',async()=>{
  const calls=[];
  const result=await execute({companyId:'example-co',appIds:['portal']},async(prompt,options)=>{
    calls.push(options);
    return {summary:'No telemetry supplied',claims:[],gaps:['No telemetry supplied']};
  },()=>{});
  assert.deepEqual(calls.map(c=>c.agentType),['product-investigator','product-investigator','refuter']);
  assert.equal(result.findings,0);
  assert.equal(result.review.gaps[0],'No telemetry supplied');
});
test('missing application context or unavailable analysis prevents continuation',async()=>{
  await assert.rejects(execute({},()=>{},()=>{}));
  let calls=0;
  const result=await execute({companyId:'example-co',appIds:['portal']},async()=>{calls++;return null;},()=>{});
  assert.equal(calls,1);assert.equal(result.complete,false);
});
test('unsupported model conclusions and out-of-scope citations stop the workflow',async()=>{
  for(const evidence of [[],[{path:'applications/other/server.js',revision:'a'.repeat(40),detail:'line 1'}]]){
    let calls=0;
    const result=await execute({companyId:'example-co',appIds:['portal']},async()=>{calls++;return {
      summary:'claim',gaps:[],claims:[{statement:'Root cause',status:'supported',evidence}]
    };},()=>{});
    assert.equal(calls,1);assert.equal(result.complete,false);
  }
});
