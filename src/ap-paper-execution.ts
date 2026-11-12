import type { MultiScenarioDryRunEngine } from './multi-scenario-dryrun-engine.js';
import { matchesApTicket, type ApQuoteTicket } from './ap-paper-accounting.js';

export interface ApPaperRequest { lane:string; mint:string; stakeUsd:number; baseUnits?:string; decimals?:number; pairAddress?:string; solUsd:number }
export interface ApPaperDependencies {
  buy:(request:ApPaperRequest)=>Promise<any>; sell:(request:ApPaperRequest)=>Promise<any>;
  audit:(event:any)=>void; sleep:(ms:number)=>Promise<void>;
}
/** Bounded in-page route fetch; no token-stat/pair discovery or real token balance. */
export async function apBrowserSellQuote(page:any, request:ApPaperRequest):Promise<any> {
  if(!page || page.isClosed()) return {ok:false,error:'PAGE_UNAVAILABLE'};
  if(!request.pairAddress) return {ok:false,error:'PAIR_UNAVAILABLE'};
  return page.evaluate(async (r:ApPaperRequest)=>{
    const params=new URLSearchParams({web_from_source:'token_poll',token_in_chain:'sol',token_out_chain:'sol',
      from_address:'F2yWctiAKCa3EDCsXUgTQfHd1r3u5VpaWsDymkDGxqt6',token_in_address:r.mint,
      token_out_address:'So11111111111111111111111111111111111111112',in_amount:r.baseUnits!,
      pair_address:r.pairAddress!,slippage:'20',is_anti_mev:'false',fee:'0.0002',tip_fee:'0.0001',priority_fee:'0.0001',legacy:'true'});
    try {
      const response=await fetch(`/txproxy/v1/get_swap_route?${params}`,{credentials:'include',signal:AbortSignal.timeout(3500)});
      const body=await response.json();
      return response.ok&&body?.code===0&&body?.data?.quote ? {ok:true,routeData:body.data}:
        {ok:false,error:body?.msg||body?.message||'NO_ROUTE'};
    }catch(e){return {ok:false,error:String(e)}}
  },request);
}
export async function boundedApQuote<T>(work:()=>Promise<T>, timeoutMs=4000):Promise<T> {
  let timer:ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([Promise.resolve().then(work),new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(new Error('QUOTE_TIMEOUT')),timeoutMs);
  })]); } finally { if(timer) clearTimeout(timer); }
}
export function validApRoute(route:any, req:ApPaperRequest, side:'BUY'|'SELL'):boolean {
  const q=route?.routeData?.quote;
  if (!route?.ok || !q || !/^\d+$/.test(q.outAmount) || BigInt(q.outAmount)<=0n ||
    !/^\d+$/.test(q.inAmount) || BigInt(q.inAmount)<=0n || !Number.isFinite(req.solUsd) || req.solUsd<=0) return false;
  if(side==='SELL') return q.inAmount===req.baseUnits && (q.inDecimals==null || q.inDecimals===req.decimals) &&
    (q.outDecimals==null || q.outDecimals===9);
  const decimals=q.outDecimals;
  return Number.isInteger(decimals) && decimals>=0 && decimals<=18 &&
    Math.abs(Number(q.inAmount)-Math.floor(req.stakeUsd/req.solUsd*1e9))<=1;
}
export async function executeApPaperQuote(engine:MultiScenarioDryRunEngine, ticket:ApQuoteTicket, stakeUsd:number,
  reason:string, solUsd:number, deps:ApPaperDependencies):Promise<void> {
  const s=engine.getScenarioById(ticket.lane), p=s.openPositions.find(p=>p.mint===ticket.mint);
  if(!p || !matchesApTicket(s,p,ticket)) return;
  const req:ApPaperRequest={lane:s.id,mint:p.mint,stakeUsd,baseUnits:ticket.baseUnits,decimals:ticket.decimals,
    pairAddress:ticket.pairAddress,solUsd};
  try {
    let selected:any;
    const probes=ticket.side==='BUY'?2:1;
    for(let probe=1;probe<=probes;probe++) {
      if(probe===2) await deps.sleep(300);
      let route:any, error:string|undefined;
      try { route=await boundedApQuote(()=>ticket.side==='BUY'?deps.buy(req):deps.sell(req)); }
      catch(e) { error=String(e); }
      const valid=validApRoute(route,req,ticket.side);
      deps.audit({type:'AP_PAPER_QUOTE',ticket,request:req,probe,selected:valid&&probe===probes,
        quote:route?.routeData?.quote||null,error:error||route?.error||(!valid?'MALFORMED_QUOTE':undefined)});
      if(!valid) throw Error(error||route?.error||'MALFORMED_QUOTE');
      selected=route.routeData.quote;
    }
    if(ticket.side==='BUY') {
      const tokens=Number(selected.outAmount)/10**selected.outDecimals;
      engine.syncRealBuyExecution(s.id,p.mint,stakeUsd/tokens,tokens,stakeUsd,
        {...ticket,baseUnits:selected.outAmount,decimals:selected.outDecimals});
    } else {
      const gross=Number(selected.outAmount)/1e9*solUsd;
      engine.syncRealSellExecution(s.id,p.mint,gross/ticket.tokens,gross,reason,ticket);
    }
  } catch(error) {
    if(ticket.side==='BUY') engine.abortScenarioBuy(s.id,p.mint,String(error),ticket);
    else engine.recordFailedSellExecution(s.id,p.mint,String(error),ticket);
  }
}
