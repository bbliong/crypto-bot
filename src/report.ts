import { mkdirSync, writeFileSync } from 'node:fs';
import type { Report } from './model.js';
export function writeReport(report: Report) {
  mkdirSync('reports', { recursive: true });
  const path = 'reports/' + report.mint + '.json';
  writeFileSync(path, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, mint: report.mint, mode: report.mode, report: path,
    unknown: report.checks.filter(x => x.status === 'UNKNOWN').map(x => x.name) }));
}
