import { requireNativeModule } from "expo";

export interface NativeConversationSpec {
  conversationId: string;
  agentId: string;
  title: string;
}

export interface NativePollOptions {
  /** Conversations to poll (those resolved to ALL_MESSAGES). */
  conversations: NativeConversationSpec[];
  /** Cloud REST base URL, e.g. https://api.letta.com */
  baseUrl: string;
  /** Bearer token (API key or OAuth access token). */
  token: string;
  /** Epoch ms — runs completed before this (minus a 5s margin) are ignored. */
  pollStartedAt: number;
  /** Run IDs already notified by the stream (dedup seed). */
  notifiedRunIds: string[];
  /** Poll interval in ms (default 20_000). */
  pollIntervalMs?: number;
}

declare class BackgroundPollNativeModule {
  startPolling(options: {
    conversations: string; // JSON-encoded NativeConversationSpec[]
    baseUrl: string;
    token: string;
    pollStartedAt: number;
    notifiedRunIds: string[];
    pollIntervalMs?: number;
  }): Promise<void>;
  stopPolling(): Promise<void>;
  setVisibleConversation(conversationId: string | null): Promise<void>;
}

const native = requireNativeModule<BackgroundPollNativeModule>("BackgroundPoll");

/** Start native polling for the given conversations. */
export function startPolling(options: NativePollOptions): Promise<void> {
  return native.startPolling({
    conversations: JSON.stringify(options.conversations),
    baseUrl: options.baseUrl,
    token: options.token,
    pollStartedAt: options.pollStartedAt,
    notifiedRunIds: options.notifiedRunIds,
    pollIntervalMs: options.pollIntervalMs,
  });
}

/** Stop native polling. */
export function stopPolling(): Promise<void> {
  return native.stopPolling();
}

/** Suppress notifications for the conversation currently on screen. */
export function setVisibleConversation(conversationId: string | null): Promise<void> {
  return native.setVisibleConversation(conversationId);
}
