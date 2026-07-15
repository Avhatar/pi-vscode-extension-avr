/**
 * Hidden extension messages still participate in the model context, but must
 * not be rendered as chat messages. Other roles ignore the extension-specific
 * display flag.
 */
export function shouldDisplayChatMessage(message: any): boolean {
    return message?.role !== 'custom' || message.display !== false;
}
