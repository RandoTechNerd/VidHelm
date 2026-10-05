// Types for agent/timeouts.mjs, so electron/main.ts can import the shared table.
export declare const QUICK_MS: number
export declare const MEDIUM_MS: number
export declare const LONG_MS: number
export declare const GEN_CLIP_MS: number
export declare const EXPORT_MS: number
export declare const PROXY_SLACK_MS: number
export declare const ACTION_TIMEOUTS: Record<string, number>
export declare function bridgeTimeoutMs(cmd: { action?: string; at?: unknown } | null | undefined): number
export declare function proxyTimeoutMs(cmd: { action?: string; at?: unknown } | null | undefined): number
