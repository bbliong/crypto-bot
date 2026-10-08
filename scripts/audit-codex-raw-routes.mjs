// Read-only audit. Never persist URLs, headers, raw transaction messages, or account responses.
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {historySources, readHistoryLines, HISTORY_CUTOFF} from './codex-history-source.mjs';
const SOL='So11111111111111111111111111111111111111112';
const number=x=>x==null||x===''||!Number.isFinite(Number(x))?null:Number(x);
export function extractRoute(row){
  let body;try{body=typeof row.bodyText==='string'?JSON.parse(row.bodyText):row.bodyText;}catch{return null;}
  const d=body?.data,q=d?.quote;if(!q||!q.inputMint||!q.outputMint)return null;
  const side=q.inputMint===SOL?'buy':q.outputMint===SOL?'sell':'other';
  const out=number(q.outAmount),min=number(q.otherAmountThreshold),slippage=number(q.slippageBps);
  return {at:number(row.observedAt),side,mint:side==='buy'?q.outputMint:q.inputMint,
    inAmount:q.inAmount??null,outAmount:q.outAmount??null,minOut:q.otherAmountThreshold??null,
    inDecimals:number(q.inDecimals),outDecimals:number(q.outDecimals),
    inUsd:number(d.amount_in_usd),outUsd:number(d.amount_out_usd),
    priceImpactPct:number(q.priceImpactPct),slippageBps:slippage,
    impliedMinOutHaircutPct:out>0&&min!==null?(1-min/out)*100:null,
    platformFee:q.platformFee??null,solCostLamports:number(d.sol_cost),
    priorityLamports:number(d.raw_tx?.prioritizationFeeLamports),
    contextSlot:number(q.contextSlot??d.contextSlot),lastValidBlockHeight:number(d.raw_tx?.lastValidBlockHeight),
    hasBlockhash:!!d.raw_tx?.recentBlockhash,
    hops:(q.routePlan??[]).map(h=>({label:h.swapInfo?.label??null,
      feeAmount:h.swapInfo?.feeAmount??null,feeMint:h.swapInfo?.feeMint??null})),
    successfulHttp:row.status>=200&&row.status<300,code:body.code??null};
}
const quantiles=values=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return {n:a.length,
  min:a[0]??null,p50:a[Math.floor(a.length*.5)]??null,p90:a[Math.floor(a.length*.9)]??null,max:a.at(-1)??null};};
export function signalRouteCoverage(signals,routes){
  const grouped=new Map();for(const q of routes){if(q.side!=='buy')continue;if(!grouped.has(q.mint))grouped.set(q.mint,[]);grouped.get(q.mint).push(q);}
  const result={signals:signals.length,anyPrior2s:0,stake50cPrior2s:0,stake10Prior2s:0,withSlotPrior2s:0};
  for(const s of signals){const qs=(grouped.get(s.mint)??[]).filter(q=>q.at<=s.at&&q.at>=s.at-2000&&q.successfulHttp&&q.outAmount>0);
    if(qs.length)result.anyPrior2s++;if(qs.some(q=>q.contextSlot!==null))result.withSlotPrior2s++;
    if(qs.some(q=>q.inUsd!==null&&Math.abs(q.inUsd-.5)<=.05))result.stake50cPrior2s++;
    if(qs.some(q=>q.inUsd!==null&&Math.abs(q.inUsd-10)<=1))result.stake10Prior2s++;
  }return result;
}
async function main(){
  const routes=[],seen=new Set(),files=[],endpoints={},swaps={rows:0,withHash:0,states:{},errors:{}},poolFees=[];
  let malformedBodies=0,excludedAfterCutoff=0;
  for(const source of historySources())for(const file of ['order-api-payloads.jsonl','order-followup-responses.jsonl']){
    let kept=0;
    const count=await readHistoryLines(source,file,row=>{
      if(!(row.observedAt<HISTORY_CUTOFF)){excludedAfterCutoff++;return;}
      if(!row.type?.includes('RESPONSE')||!row.bodyText)return;
      let path;try{path=new URL(row.url).pathname;}catch{return;}
      const kind=path.endsWith('/get_swap_route')?'route':path.endsWith('/swap_batch_order')?'swap':
        /\/token_pool_fee_info\//.test(path)?'poolFee':null;if(!kind)return;
      let body;try{body=typeof row.bodyText==='string'?JSON.parse(row.bodyText):row.bodyText;}catch{malformedBodies++;return;}
      const key=createHash('sha256').update(JSON.stringify([kind,row.observedAt,body])).digest('hex');
      if(seen.has(key))return;seen.add(key);kept++;endpoints[kind]=(endpoints[kind]??0)+1;
      if(kind==='route'){const q=extractRoute(row);if(q)routes.push({...q,source:source.id});}
      if(kind==='swap'){
        const d=body.data??{};swaps.rows++;if(d.hash)swaps.withHash++;
        swaps.states[String(d.state)]=(swaps.states[String(d.state)]??0)+1;
        if(d.error_code)swaps.errors[String(d.error_code)]=(swaps.errors[String(d.error_code)]??0)+1;
      }
      if(kind==='poolFee')for(const p of body.data?.list??[])poolFees.push({at:row.observedAt,
        exchange:p.exchange,feeRatio:number(p.fee_ratio),creatorFeeBps:number(p.creator_fee_bps),dynamic:!!p.is_dynamic_fee});
    });
    if(count.lines)files.push({source:source.id,file,...count,kept});
  }
  routes.sort((a,b)=>a.at-b.at);
  const signals=JSON.parse(readFileSync('reports/codex-v2-all-history.json')).records;
  const summary={cutoff:new Date(HISTORY_CUTOFF).toISOString(),files:files.length,rowsRead:files.reduce((s,f)=>s+f.lines,0),
    malformedBodies,excludedAfterCutoff,endpoints,routeQuotes:routes.length,mints:new Set(routes.map(q=>q.mint)).size,
    withMinOut:routes.filter(q=>q.minOut!==null).length,withContextSlot:routes.filter(q=>q.contextSlot!==null).length,
    withBlockhash:routes.filter(q=>q.hasBlockhash).length,withBlockHeight:routes.filter(q=>q.lastValidBlockHeight!==null).length,
    solCostLamports:quantiles(routes.map(q=>q.solCostLamports)),priorityLamports:quantiles(routes.map(q=>q.priorityLamports)),
    platformFees:{zero:routes.filter(q=>number(q.platformFee)===0).length,
      nonzero:routes.filter(q=>number(q.platformFee)>0).length,
      missingOrStructured:routes.filter(q=>number(q.platformFee)===null).length},
    hopFeeLabels:[...new Set(routes.flatMap(q=>q.hops.filter(h=>number(h.feeAmount)>0).map(h=>h.label)))],
    slippageBps:[...new Set(routes.map(q=>q.slippageBps))],
    poolFeeRatios:quantiles(poolFees.map(p=>p.feeRatio)),swaps,coverage:signalRouteCoverage(signals,routes)};
  writeFileSync('reports/codex-raw-route-audit.json',JSON.stringify({summary,files,poolFees,routes,
    caveats:['Deduplication uses endpoint category + receipt timestamp + exact body. Polls with different times remain separate observations.',
      'A quote is not a confirmed fill. Swap state codes are preserved but not interpreted without a documented state machine.',
      'sol_cost is an unverified cost field: do not equate it with a final fee or blindly add it to priority/platform fees.',
      'Per-hop fees may already be reflected in quoted output. Do not subtract them twice.',
      'Counterfactual entry coverage uses only already-received buy quotes within 2s. Never substitute a later quote.']},null,2));
  console.log(JSON.stringify(summary));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
