import { chatReducer, isActive, type ChatState } from "./chat-state";

/**
 * The conversation handed from the floating panel to the full page when the reader expands it.
 * Module memory only, so it survives the client-side navigation and nothing is stored. Answers
 * still being written are marked stopped: the stream belongs to the panel that is closing.
 */
let carried: ChatState | null = null;

export function carryConversation(chat: ChatState): void {
  carried = chat.messages
    .filter(isActive)
    .reduce((state, m) => chatReducer(state, { type: "stop", id: m.id }), chat);
}

export const carriedConversation = (): ChatState | null => carried;

export function clearCarriedConversation(): void {
  carried = null;
}
