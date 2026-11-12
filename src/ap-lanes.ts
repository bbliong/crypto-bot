import type {ScenarioState} from './multi-scenario-dryrun-engine.js';

export const AP_LANES = [
 {key:'s14',id:'SCENARIO_14_BUNDLER_RUNNER',label:'AP1',parentKey:'s14',net10:false,aliases:['ap1','s14','sce14','scenario_14']},
 {key:'s14_alpha',id:'SCENARIO_14_ALPHA_60S_GRACE',label:'AP2',parentKey:'s14_alpha',net10:false,aliases:['ap2','s14_alpha','sce14_alpha','scenario_14_alpha']},
 {key:'s14_beta',id:'SCENARIO_14_BETA_HOARDING_DEFENSE',label:'AP3',parentKey:'s14_beta',net10:false,aliases:['ap3','s15','sce15','s14_beta','sce14_beta','scenario_14_beta']},
 {key:'s14_net10',id:'SCENARIO_14_BUNDLER_RUNNER_NET10',label:'AP1-10%',parentKey:'s14',net10:true,aliases:['ap1-10%','ap1-net10','s14_net10','sce14_net10']},
 {key:'s14_alpha_net10',id:'SCENARIO_14_ALPHA_60S_GRACE_NET10',label:'AP2-10%',parentKey:'s14_alpha',net10:true,aliases:['ap2-10%','ap2-net10','s14_alpha_net10','sce14_alpha_net10']},
 {key:'s14_beta_net10',id:'SCENARIO_14_BETA_HOARDING_DEFENSE_NET10',label:'AP3-10%',parentKey:'s14_beta',net10:true,aliases:['ap3-10%','ap3-net10','s14_beta_net10','sce14_beta_net10']},
] as const;
export type ApLaneKey=typeof AP_LANES[number]['key'];
export function resolveApLane(raw:string){const id=String(raw||'').toLowerCase().trim();
 return AP_LANES.find(l=>l.id.toLowerCase()===id || (l.aliases as readonly string[]).includes(id));}
export const isNet10=(raw:string)=>resolveApLane(raw)?.net10===true;
export function freshApNet10(key:ApLaneKey):ScenarioState {
 const lane=AP_LANES.find(l=>l.key===key&&l.net10);if(!lane)throw Error('INVALID_NET10_LANE');
 return {id:lane.id,name:lane.label,description:`PAPER ONLY · Entry/safety ${lane.parentKey} unchanged; full liquidation net TP +10%. Unmatched legacy capital cohort — not fair performance A/B.`,
  initialCash:5,availableCash:5,investedCash:0,totalFeesPaid:0,realizedPnl:0,unrealizedPnl:0,totalPortfolioValue:5,
  wins:0,losses:0,totalTrades:0,winRate:0,openPositions:[],closedTrades:[],recentEvents:[],apBoughtMints:[],apTrackers:{}};
}
