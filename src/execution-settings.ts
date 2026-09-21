/**
 * Local execution policy for paper simulation and UI preparation.
 * These values are deliberately not written to the GMGN account and this
 * project never submits a buy or sell transaction.
 */
export interface ExecutionSettings {
  slippagePercent: number;
  priorityFeeSol: number;
  tipFeeSol: number;
  maxAutoPriorityFeeSol: number;
  antiMev: boolean;
}

export const DEFAULT_EXECUTION_SETTINGS: Readonly<ExecutionSettings> = Object.freeze({
  slippagePercent: 15,
  priorityFeeSol: 0.0001,
  tipFeeSol: 0.0001,
  maxAutoPriorityFeeSol: 0.0001,
  antiMev: false,
});
