/** Convert SDK/runtime payloads into transport-safe plain data. */
export function safeSerialize(value: any): any {
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return { type: value?.type, _serializationFailed: true };
    }
}
