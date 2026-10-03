/** Independent Codex v2 research hypothesis; not wired to live or Gemini lanes. */
export const CODEX_FLOW_WAVE_V2 = 'codex-flow-wave-v2';
export type FlowWaveEntry = {id:string;historySec:number;minReturn:number;maxReturn:number;buy5:number;buyLong:number|null;
  longSec:number;buyers:number;buyUsd:number;topBuyer:number;maxTop1:number;maxMc:number;reclaim:boolean};
const base:FlowWaveEntry={id:'continuation',historySec:7,minReturn:1,maxReturn:12,buy5:.65,buyLong:null,
  longSec:10,buyers:4,buyUsd:300,topBuyer:.5,maxTop1:8,maxMc:100000,reclaim:false};
export const FLOW_WAVE_ENTRIES:readonly FlowWaveEntry[]=Object.freeze([
  {...base},
  {...base,id:'pressure',minReturn:2,maxReturn:15,buy5:.8,buyers:5,buyUsd:500,topBuyer:.35,maxTop1:6,maxMc:50000},
  {...base,id:'sustained10',historySec:12,minReturn:.5,buy5:.6,buyLong:.65},
  {...base,id:'reclaim',historySec:12,minReturn:0,maxReturn:8,buy5:.6,buyLong:.6,reclaim:true},
  {...base,id:'sustained20',historySec:22,minReturn:.25,maxReturn:15,buy5:.6,buyLong:.65,longSec:20},
  {...base,id:'broad_control',historySec:7,minReturn:.25,maxReturn:20,buy5:.6,buyers:3,topBuyer:.5},
].map(x=>Object.freeze(x)));
export type FlowWaveFeatures={historySec:number;ready:boolean;return5:number|null;return2:number|null;drawdown5:number;
  buy5:number|null;buy2:number|null;buy10:number|null;buy20:number|null;buyers:number;trades:number;buyUsd:number;topBuyer:number|null;
  mc:number|null;top1:number|null;top5:number|null;dev:number|null;holders:number|null;tokenAgeSec:number|null;
  holderFresh:boolean;devFresh:boolean;countFresh:boolean;majorSell:boolean;devSell30:number;drawdown10:number;
  rebound10:number;peakBeforeTrough:boolean;aboveWeightedPrice:boolean};
const finite=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x);
export function flowWaveEntryAllowed(f:FlowWaveFeatures,r:FlowWaveEntry){
  if(!f.ready||f.historySec<r.historySec||!finite(f.tokenAgeSec)||f.tokenAgeSec<15)return false;
  if(!f.holderFresh||!f.devFresh||!f.countFresh||!finite(f.holders)||f.holders<40)return false;
  if(!finite(f.top1)||!finite(f.top5)||!finite(f.dev)||f.top1>r.maxTop1||f.top5>30||f.dev>2.5)return false;
  if(!finite(f.mc)||f.mc<5500||f.mc>r.maxMc||f.majorSell||!finite(f.devSell30)||f.devSell30>=25)return false;
  if(!finite(f.return5)||f.return5<r.minReturn||f.return5>r.maxReturn||!finite(f.return2)||f.return2<=0||f.drawdown5>2.5||f.drawdown10>15)return false;
  if(!finite(f.buy5)||f.buy5<r.buy5||!finite(f.buy2)||f.buy2<.6||f.buyers<r.buyers||f.trades<5||
    f.buyUsd<r.buyUsd||!finite(f.topBuyer)||f.topBuyer>r.topBuyer)return false;
  const longer=r.longSec===20?f.buy20:f.buy10;
  if(r.buyLong!==null&&(!finite(longer)||longer<r.buyLong))return false;
  if(r.reclaim&&(!f.peakBeforeTrough||f.rebound10<2||f.rebound10>8||f.buy2<.75||!f.aboveWeightedPrice))return false;
  return true;
}
export type FlowWaveExit={id:string;priceStop:number;extraNetRisk:number;maxNetRisk:number;targetNet:number;trailNet:number;
  floorActivation:number;runnerActivation:number;stagnationSec:number;maxHoldSec:number};
export const FLOW_WAVE_EXITS:readonly FlowWaveExit[]=Object.freeze([
  {id:'scalp',priceStop:4,extraNetRisk:4,maxNetRisk:20,targetNet:8,trailNet:4,floorActivation:4,runnerActivation:8,stagnationSec:12,maxHoldSec:30},
  {id:'balanced',priceStop:6,extraNetRisk:6,maxNetRisk:20,targetNet:15,trailNet:5,floorActivation:6,runnerActivation:10,stagnationSec:20,maxHoldSec:60},
  {id:'runner',priceStop:8,extraNetRisk:8,maxNetRisk:25,targetNet:25,trailNet:7,floorActivation:8,runnerActivation:12,stagnationSec:25,maxHoldSec:90},
].map(x=>Object.freeze(x)));
/** Risk starts with the actual all-in purchase cost. Fixed cost is never hidden or subtracted twice. */
export function flowWaveNetFloor(immediateNet:number,r:FlowWaveExit){return Math.max(-r.maxNetRisk,immediateNet-r.extraNetRisk);}
export function flowWaveNetReturn(stake:number,solUsd:number,buyPrice:number,sellPrice:number,feeSide=.01,networkSol=.000205){
  const input=stake/solUsd;
  return ((input*(1-feeSide)**2*(sellPrice/buyPrice)-networkSol)/(input+networkSol)-1)*100;
}
