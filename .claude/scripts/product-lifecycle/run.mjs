#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ProductLifecycle } from './service.mjs';
import { repositoryFiles } from './discover.mjs';
import { ExportStateStore } from '../feature-runtime/store.mjs';
try {
  const {values}=parseArgs({options:{
    operation:{type:'string'},checkout:{type:'string'},company:{type:'string'},app:{type:'string'},env:{type:'string'},
    revision:{type:'string'},file:{type:'string'},field:{type:'string'},expected:{type:'string'},
    'request-id':{type:'string'},'state-session':{type:'string'},id:{type:'string'},'expected-revision':{type:'string'}
  }});
  const service=new ProductLifecycle({
    store:new ExportStateStore({sessionId:values['state-session']}),
    authorize:async(_session,companyId)=>({companyId,id:'host:'+process.getuid()}),
    load:async({revision})=>repositoryFiles(values.checkout,revision,[values.file])
  });
  const input={companyId:values.company,id:values.id,expectedRevision:Number(values['expected-revision'])};
  let result;
  if(values.operation==='prepare') {
    result=await service.start({...input,application:values.app,environment:values.env,revision:values.revision,
      requestId:values['request-id'],
      check:{version:1,type:'json-field-equals',path:values.file,field:values.field?.split('.'),expected:JSON.parse(values.expected)}});
  } else if(values.operation==='read' || values.operation==='cancel') {
    result=await service[values.operation](input);
  } else throw new Error('Use operation prepare, read or cancel.');
  console.log(JSON.stringify(result));
} catch(error) { console.error(error.message);process.exitCode=2; }
