/** Semantic requests that require a frontend or host-platform capability. */
export type PlatformClientMessage =
    | { type: 'openFile'; filePath: string }
    | { type: 'confirmAction'; action: string; message: string; payload?: any };

/** Platform capability results return through correlated request responses. */
export type PlatformServerMessage = never;
