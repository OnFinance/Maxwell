// Read-only Sentry Cloud adapter. Export only minimal, revision-bound event metadata.
import { ensure } from './model.mjs';
export async function collectSentry({organization,project,environment,revision,token,fetcher=fetch}) {
  ensure([organization,project,environment].every(s=>typeof s==='string' && /^[a-zA-Z0-9_-]{1,100}$/.test(s)) &&
    /^[a-f0-9]{40}$/.test(revision),'Invalid Sentry scope.');
  ensure(typeof token==='string' && token.trim(),'Sentry read token is not configured.');
  const url=new URL('https://sentry.io/api/0/projects/'+organization+'/'+project+'/events/');
  url.searchParams.set('statsPeriod','24h');url.searchParams.set('full','false');
  const response=await fetcher(url,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(10000)});
  ensure(response.ok,'Sentry request failed with HTTP '+response.status+'.');
  const parts=[];let size=0;
  for await(const part of response.body){
    size+=part.length;ensure(size<=1024*1024,'Sentry response exceeds 1 MiB.');parts.push(part);
  }
  const events=JSON.parse(Buffer.concat(parts).toString('utf8'));
  ensure(Array.isArray(events),'Unexpected Sentry response.');
  const signals=[];
  let omitted=0;
  for(const event of events){
    const tags=new Map((event.tags??[]).map(t=>[t.key,t.value]));
    if(tags.get('environment')!==environment)continue;
    if(tags.get('release')!==revision || !/^[a-f0-9]{16,64}$/i.test(event.eventID??'') ||
      typeof event.dateCreated!=='string' || !Number.isFinite(Date.parse(event.dateCreated))){omitted++;continue;}
    signals.push({id:'sentry:'+event.eventID,at:event.dateCreated,type:'error',revision,
      summary:'Sentry error event observed in the selected environment and release.'});
  }
  return {provider:'sentry-cloud',organization,project,environment,revision,signals,
    complete:false,gaps:['A single bounded page of error events cannot establish incident cause or service health.',
      ...(omitted?['Some events lacked the selected release or valid metadata.']:[])]};
}
