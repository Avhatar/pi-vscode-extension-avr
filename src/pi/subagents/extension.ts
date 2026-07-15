import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSubagentTool, type SubagentToolServices } from './tool';

export function createSubagentExtension(
    services: SubagentToolServices,
): (api: ExtensionAPI) => void {
    return (api) => registerSubagentTool(api, services);
}
