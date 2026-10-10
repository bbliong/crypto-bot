import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
const dir=process.argv[2]||'reports/profit4-patterns-2026-10-10';
const c=JSON.parse(gunzipSync(fs.readFileSync(path.join(dir,'runner-cache.json.gz'))));
const study=JSON.parse(fs.readFileSync(path.join(dir,'runner-study.json')));
const dominant=new Map();
for(const r of study.decisions.filter(r=>r.seconds===60&&r.f.topBuyer60)){
  const w=r.f.topBuyer60,a=dominant.get(w)||[];a.push({mint:r.mint,symbol:r.symbol,share:r.f.topBuyerPct60,target:r.outcome.status==='TARGET'});dominant.set(w,a);
}
const dumps=[];
for(const t of c.tokens){let peak=0;
  for(let i=0;i<t.series.length;i++){
    const b=t.series[i];peak=Math.max(peak,b.p);if(b.p>peak*.4)continue;
    const w=t.series.filter(x=>x.at>=b.at-5000&&x.at<=b.at),totals=new Map();
    for(const x of w)for(const[wa,usd]of Object.entries(x.sellers))totals.set(wa,(totals.get(wa)||0)+usd);
    const top=[...totals].sort((a,b)=>b[1]-a[1])[0];
    const pre=t.series.filter(x=>x.at<b.at);
    const lastQuote=pre.at(-1);
    const firstMajor=pre.find(x=>x.maxSell>=100),firstWalletSale=top?pre.find(x=>(x.sellers[top[0]]||0)>=100):null;
    const previous5=t.series.filter(x=>x.at>=b.at-5000&&x.at<b.at);
    dumps.push({mint:t.mint,symbol:t.symbol,firstAt:t.firstAt,dumpAt:b.at,seconds:(b.at-t.firstAt)/1000,
      ddPct:100*(1-b.p/peak),oneStepDropPct:lastQuote?(1-b.p/lastQuote.p)*100:null,previousGapSeconds:lastQuote?(b.at-lastQuote.at)/1000:null,
      seller:top?.[0]||null,sellerUsd5s:top?.[1]||0,
      firstSell100LeadSeconds:firstMajor?(b.at-firstMajor.at)/1000:null,
      firstDumperSell100LeadSeconds:firstWalletSale?(b.at-firstWalletSale.at)/1000:null,
      pre5SellUsd:previous5.reduce((n,x)=>n+x.sell,0)});break;
  }
}
const sellers=new Map();for(const r of dumps)if(r.seller){const a=sellers.get(r.seller)||[];a.push(r);sellers.set(r.seller,a);}
const med=a=>{a=a.filter(x=>x!==null).sort((a,b)=>a-b);return a.length?a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2:null;};
const result={cutoff:c.cutoff,method:'Dominant buyer measured at causal 60s checkpoint over prior60s meaningful buys >=$1. Dominant dump seller selected retrospectively by largest total sold in [dumpAt-5s,dumpAt], from meaningful sells >=$1. These wallet identities are descriptive findings, not automatically causal entry filters. All 94 captured tokens, first peak-to-price drawdown>=60%.',
  buyers:[...dominant].map(([wallet,a])=>({wallet,tokens:a.length,targets:a.filter(r=>r.target).length,medianShare:med(a.map(r=>r.share)),rows:a})).sort((a,b)=>b.tokens-a.tokens),
  sellers:[...sellers].map(([wallet,a])=>({wallet,tokens:a.length,firstKnownDumpAt:Math.min(...a.map(r=>r.dumpAt)),medianSaleUsd:med(a.map(r=>r.sellerUsd5s)),minSaleUsd:Math.min(...a.map(r=>r.sellerUsd5s)),maxSaleUsd:Math.max(...a.map(r=>r.sellerUsd5s))})).sort((a,b)=>b.tokens-a.tokens),
  summary:{dumps:dumps.length,noEarlierDumperSell100:dumps.filter(r=>r.seller&&r.firstDumperSell100LeadSeconds===null).length,
    noEarlierAnySell100:dumps.filter(r=>r.firstSell100LeadSeconds===null).length,
    stepDropMedian:med(dumps.filter(r=>r.previousGapSeconds<=5).map(r=>r.oneStepDropPct)),stepsWithin5s:dumps.filter(r=>r.previousGapSeconds<=5).length,
    medianPre5SellUsd:med(dumps.map(r=>r.pre5SellUsd))},dumps};
fs.writeFileSync(path.join(dir,'runner-wallet-audit.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({buyers:result.buyers.map(({rows,...r})=>r),sellers:result.sellers.slice(0,5),summary:result.summary},null,2));
