export const number = v => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
export function stats(values) {
  const a = values.map(number).filter(v => v !== null).sort((a,b) => a-b);
  const quantile = q => { const i=(a.length-1)*q, lo=Math.floor(i); return a.length ? a[lo]+(a[Math.ceil(i)]-a[lo])*(i-lo) : null; };
  return { n:a.length, mean:a.length?a.reduce((x,y)=>x+y,0)/a.length:null, median:quantile(.5), p25:quantile(.25), p75:quantile(.75) };
}
export function pricePath(entry, start, end, trades, finalPoint) {
  if (!(entry>0)) return null;
  const points = [{t:start,p:entry,source:'openingPrice'}];
  for(const t of trades) if(t.occurredAt>=start && t.occurredAt<=end && t.priceUsd>0) points.push({t:t.occurredAt,p:t.priceUsd,source:'trade'});
  if(finalPoint?.t>=start && finalPoint.t<=end && finalPoint.p>0) points.push(finalPoint);
  points.sort((a,b)=>a.t-b.t);
  let peak=points[0], maxDrawdown=0;
  for(const p of points){ if(p.p>peak.p) peak=p; maxDrawdown=Math.max(maxDrawdown,(peak.p-p.p)/peak.p*100); }
  const later=points.filter(p=>p.t>peak.t);
  const trough=later.length?later.reduce((a,b)=>b.p<a.p?b:a):null;
  const last=points.at(-1);
  const firstHit = threshold => points.find(p=>threshold>=0 ? (p.p/entry-1)*100>=threshold : (p.p/entry-1)*100<=threshold)?.t??null;
  return {points, peak, trough, last, peakGain:(peak.p/entry-1)*100, lastReturn:(last.p/entry-1)*100,
    afterPeakReturn:trough?(trough.p/entry-1)*100:null, afterPeakDrawdown:trough?Math.max(0,(peak.p-trough.p)/peak.p*100):null,
    maxDrawdown, secondsToPeak:(peak.t-start)/1000, hits:{10:firstHit(10),20:firstHit(20),50:firstHit(50),minus20:firstHit(-20)} };
}
