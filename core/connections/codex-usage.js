const amount=x=>Number.isFinite(x)&&x>=0?x:null;
export function usageFromSDK(x){return {inputTokens:amount(x?.input_tokens),cachedInputTokens:amount(x?.cached_input_tokens),outputTokens:amount(x?.output_tokens),cost:null,source:'codex-sdk-turn',billing:'subscription'};}
export function projectUsage(x){return !x?null:{inputTokens:amount(x.inputTokens),cachedInputTokens:amount(x.cachedInputTokens),outputTokens:amount(x.outputTokens),cost:null,source:'codex-sdk-turn',billing:'subscription'};}
export const projectThread=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x)?x:null;
// Explicit projection prevents arbitrary provider fields entering durable evidence.
export function quotaFromAppServer(x,observedAt=Date.now()){
 const window=w=>!w?null:{usedPercent:amount(w.usedPercent),windowDurationMins:amount(w.windowDurationMins),resetsAt:amount(w.resetsAt)};
 const label=v=>typeof v==='string'&&v.length<=128?v:null;
 const bucket=(b,key=null)=>!b?null:{limitId:label(b.limitId)??label(key),primary:window(b.primary),secondary:window(b.secondary),reached:b.rateLimitReachedType!=null||b.spendControlReached===true};
 const values=x?.rateLimitsByLimitId;
 const buckets=values&&typeof values==='object'?Object.entries(values).slice(0,64).map(([key,b])=>bucket(b,key)).filter(Boolean):x?.rateLimits?[bucket(x.rateLimits)]:null;
 return {source:'codex-app-server-account/rateLimits',observedAt,applicability:'account-conservative-any-reported-bucket',providerAccountId:label(x?.accountId),ordinaryUsageAllowed:typeof x?.ordinaryUsageAllowed==='boolean'?x.ordinaryUsageAllowed:null,priorDenialHeld:x?.priorDenialHeld===true,buckets};
}
export function quotaStanding(quota,now,maxAgeMs){
 if(quota?.ordinaryUsageAllowed===false||quota?.priorDenialHeld===true||quota?.buckets?.some(b=>b.reached))return 'limited';
 if(quota?.ordinaryUsageAllowed==null)return 'unknown';
 if(!quota?.buckets?.length||!Number.isFinite(quota.observedAt)||now-quota.observedAt>maxAgeMs||now<quota.observedAt)return 'unknown';
 let known=false,unknown=false;
 for(const b of quota.buckets){if(b.reached)return 'limited';for(const w of [b.primary,b.secondary]){if(!w)continue;if(w.usedPercent===null){unknown=true;continue;}if(w.resetsAt!==null&&w.resetsAt*1000<=now){unknown=true;continue;}known=true;if(w.usedPercent>=100)return 'limited';}}
 return unknown?'unknown':known?'available':'unknown';
}
