#!/usr/bin/env node
// Read-only repository discovery for a bounded set of tracked source files at an immutable revision.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import { inspectProduct, digest } from './model.mjs';
const exec = promisify(execFile);
export async function repositoryFiles(checkout, revision, selected) {
  const env={...process.env};
  for(const k of Object.keys(env)) if(k.startsWith('GIT_')) delete env[k];
  const git = async(...args)=>(await exec('git',['-C',checkout,...args],{env,timeout:15000,maxBuffer:2*1024*1024})).stdout;
  if(!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Supply a full commit SHA.');
  const names=(await git('ls-tree','-r','--name-only',revision)).trim().split('\n');
  const eligible=names.filter(p=>/(^|\/)(package.json|Dockerfile|go.mod|pyproject.toml|requirements.txt|Chart.yaml|sentry-k8s-config.md|preview-on-demand.yml)$/.test(p));
  const paths=selected ?? eligible.slice(0,100);
  const files=[];
  for(const path of paths) {
    if(!names.includes(path)) throw new Error('File is not tracked at the revision.');
    const content=await git('show',revision+':'+path);
    files.push({path,content});
  }
  return files;
}
if (process.argv[1]?.endsWith('/discover.mjs')) {
  try {
    const {values}=parseArgs({options:{checkout:{type:'string'},revision:{type:'string'},app:{type:'string'},env:{type:'string'}}});
    const files=await repositoryFiles(values.checkout,values.revision);
    const model=inspectProduct({files,revision:values.revision,application:values.app,environment:values.env});
    console.log(JSON.stringify({...model,sources:model.sources.map(({path,sha256})=>({path,sha256})),inputsHash:digest(files)}));
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
