/** Semantic requests that require a frontend or host-platform capability. */
export type PlatformClientMessage =
    | { type: 'openFile'; filePath: string }
    | { type: 'confirmAction'; action: string; message: string; payload?: any };

/** Results produced by a frontend or host-platform capability. */
export type PlatformServerMessage =
    | { type: 'confirmResult'; action: string; confirmed: boolean; payload?: any };
