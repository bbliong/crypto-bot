import type { MultiScenarioDryRunEngine, ScenarioPosition, ScenarioState } from './multi-scenario-dryrun-engine.js';
import {apTicket,isAp,matchesApTicket,type ApQuoteTicket} from './ap-paper-accounting.js';
import {boundedApQuote,validApRoute,type ApPaperDependencies,type ApPaperRequest} from './ap-paper-execution.js';

export const AP_MONITOR_DEFAULTS={intervalMs:1000,cooldownMs:5000,ttlMs:5000,timeoutMs:4000,maxConcurrency:2};
// One monitor instance per runner. Only active quoted-paper exposure is scanned.
export class ApExitMonitor {
  private active=new Set<string>();
  private cursor=0;
  public readonly options:typeof AP_MONITOR_DEFAULTS & {now:()=>number};
  constructor(private engine:MultiScenarioDryRunEngine, public deps:ApPaperDependencies,
    options:Partial<typeof AP_MONITOR_DEFAULTS> & {now?:()=>number}={}) {
    this.options={...AP_MONITOR_DEFAULTS,...options,now:options.now||Date.now};
  }
  async tick(solUsd:number):Promise<void> {
    const candidates=Object.values(this.engine.scenarios).filter(s=>isAp(s.id))
      .flatMap(s=>s.openPositions.filter(p=>p.ap&&!p.ap.status.startsWith('BUY')&&p.tokens>0).map(p=>({s,p})));
    if(!candidates.length) return;
    const work:Promise<void>[]=[];
    for(let checked=0;checked<candidates.length && this.active.size<this.options.maxConcurrency;checked++){
      const {s,p}=candidates[this.cursor%candidates.length]; this.cursor=(this.cursor+1)%candidates.length;
      const key=`${s.id}:${p.ap!.positionId}`;
      const a=p.ap!,now=this.options.now();
      if(this.active.has(key) || (a.lastAttemptAt!==undefined&&now-a.lastAttemptAt<this.options.cooldownMs)) continue;
      this.active.add(key);
      work.push(this.quote(s,p,solUsd).finally(()=>this.active.delete(key)));
    }
    await Promise.all(work);
  }
  private async quote(s:ScenarioState,p:ScenarioPosition,solUsd:number):Promise<void>{
    const a=p.ap!, now=this.options.now();
    const intent=!!a.exitReason;
    const units=intent&&a.exitBaseUnits ? a.exitBaseUnits:a.baseUnits!;
    const ticket:ApQuoteTicket=apTicket(s,p,'SELL',Number(units)/10**a.decimals!,units);
    a.pending=ticket; a.lastAttemptAt=now; a.attempts++;
    const req:ApPaperRequest={lane:s.id,mint:p.mint,stakeUsd:0,baseUnits:units,decimals:a.decimals,
      pairAddress:p.pairAddress,solUsd};
    this.engine.saveState();
    try{
      const route=await boundedApQuote(()=>this.deps.sell(req),this.options.timeoutMs);
      if(!matchesApTicket(s,p,ticket)||!s.openPositions.includes(p)) return;
      if(this.options.now()-now>this.options.ttlMs) throw Error('STALE_QUOTE');
      if(!validApRoute(route,req,'SELL')) throw Error(route?.error||'MALFORMED_QUOTE');
      const gross=Number(route.routeData.quote.outAmount)/1e9*solUsd;
      if(!Number.isFinite(gross)||gross<=0) throw Error('MALFORMED_QUOTE');
      this.deps.audit({type:'AP_MONITOR_QUOTE',ticket,request:req,quote:route.routeData.quote,selected:intent});
      a.lastFreshAt=this.options.now(); a.lastError=undefined;
      if(intent){
        this.engine.syncRealSellExecution(s.id,p.mint,gross/ticket.tokens,gross,a.exitReason!,ticket);
      }else{
        a.pending=undefined; a.status='OPEN_QUOTED';
        this.engine.evaluateApQuote(s,p,gross/ticket.tokens,gross,ticket);
      }
    }catch(error){
      if(!matchesApTicket(s,p,ticket)||!s.openPositions.includes(p)) return;
      a.status=intent?'EXIT_UNAVAILABLE':'OPEN_UNPRICED'; a.lastError=String(error).replace(/^Error: /,'');
      this.deps.audit({type:'AP_MONITOR_UNAVAILABLE',ticket,error:a.lastError});
      // Invalidate even when the underlying dependency resolves after our deadline.
      a.revision++; a.pending=undefined;
    }
    this.engine.saveState();
  }
}
