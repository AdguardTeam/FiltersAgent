/**
 * The AdGuard CLI executor-name leaf: the single spelling the AdGuard CLI proxy modules and the
 * registering executor share. No other src/ folder imports this file; the open executor-name
 * vocabulary it fills lives in src/environment/executor-name.ts.
 */

/**
 * Executor name the AdGuard CLI proxy executor registers under.
 */
export const AdguardCliExecutorName = 'adguard_cli' as const;

/**
 * AdguardCliExecutorName value.
 */
export type AdguardCliExecutorName = typeof AdguardCliExecutorName;
