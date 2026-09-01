/**
 * Agent + model operations for both connection types.
 *
 * As of SDK 0.3.1 everything here rides the portable client's first-class
 * APIs (`client.agents.*`, `client.conversations.*`, `client.models.*`,
 * `client.createAgent`) — identical on cloud and remote. The only raw REST
 * left is `pickCloudEnvironment` (environments listing has no SDK surface;
 * currently unused: environment routing closes the status socket with 1013,
 * see letta-cloud#13382).
 */
import { LettaAgentClient, createReactNativeWebSocketConstructor } from "@letta-ai/letta-agent-sdk/client";
import type {
  UpdateConversationOptions,
  LettaAgent,
  LettaCodeModelEntry,
  LettaConversation,
  ReasoningEffort,
} from "@letta-ai/letta-agent-sdk/client";

import { CLOUD_DEFAULT_URL, type Profile } from "../profiles/profiles";
import { OAuthTokenError } from "../auth/oauthTokens";

// Re-exported so UI code imports from the app's data module, but the
// definition is the SDK's — no drift (previously narrowed to low|medium|high,
// silently hiding none/minimal/xhigh).
export type { ReasoningEffort };

export interface AgentSummary {
  id: string;
  name: string;
  model: string;
  /** ISO timestamp of last activity when the server provides one. */
  lastActive?: string;
}

/** Display projection of the SDK's model entry — same fields, same names. */
export type ModelOption = Pick<LettaCodeModelEntry, "id" | "handle" | "label">;

interface Connection {
  profile: Profile;
  secret: string;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function cloudHeaders({ secret }: Connection): Record<string, string> {
  return { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
}

async function cloudFetch(conn: Connection, path: string, init?: RequestInit): Promise<unknown> {
  const url = new URL(path, CLOUD_DEFAULT_URL).toString();
  const response = await fetch(url, { ...init, headers: { ...cloudHeaders(conn), ...init?.headers } });
  if (response.status === 401 || response.status === 403) {
    throw new AuthError(`Letta API ${response.status} for ${path}`);
  }
  if (!response.ok) {
    throw new Error(`Letta API ${response.status} for ${path}`);
  }
  // DELETE and friends answer 204 with no body; json() would throw.
  if (response.status === 204) return null;
  const body = await response.text();
  return body ? JSON.parse(body) : null;
}

/** The credentials are wrong, not the network — Retry can't fix it. */
export class AuthError extends Error {}

/**
 * SDK transports throw plain Errors; classify credential failures by shape so
 * the UI can route to the profile editor instead of offering a doomed Retry.
 */
export function isAuthError(e: unknown): boolean {
  if (e instanceof AuthError || e instanceof OAuthTokenError) return true;
  const message = e instanceof Error ? e.message : "";
  return /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid (api key|token|credential)|invalid_grant|credentials/i.test(message);
}

/** The portable SDK client for the active connection. Used for createAgent and sessions. */
export function sdkClient(conn: Connection): LettaAgentClient {
  if (conn.profile.type === "cloud") {
    return new LettaAgentClient({
      backend: "cloud",
      apiKey: conn.secret,
      apiBaseUrl: CLOUD_DEFAULT_URL,
      // Browser/RN WebSockets can't set upgrade headers.
      webSocketAuth: "query",
    });
  }
  return new LettaAgentClient({
    backend: "remote",
    url: conn.profile.url,
    // Tokenless is only for non-RN loopback dev; the SDK rejects an empty
    // string, and RN clients REQUIRE a token (see WebSocket note below).
    ...(conn.secret ? { authToken: conn.secret } : {}),
    // React Native's WebSocket sends an Origin header, which app-servers
    // only accept on token-authenticated upgrades (letta-code#3511, 0.29.4+),
    // and it takes request headers via a third constructor argument — the
    // SDK's adapter bridges that. Run your server with
    // `--ws-auth capability-token` for simulator/device connections.
    ...(isReactNative()
      ? { WebSocket: createReactNativeWebSocketConstructor(globalThis.WebSocket as never) }
      : {}),
  });
}

function isReactNative(): boolean {
  // navigator.product is deprecated on the web, but it's still how RN
  // identifies itself; checked loosely so bun scripts can import this module.
  const product = (globalThis as { navigator?: { product?: string } }).navigator?.product;
  return product === "ReactNative";
}

// ── Agents ──────────────────────────────────────────────────────────────────

/** Display projection of the SDK's LettaAgent record. */
function toSummary(record: LettaAgent): AgentSummary {
  return {
    id: record.id,
    name: record.name || record.id,
    model:
      record.model ??
      (record.llm_config as { model?: string } | undefined)?.model ??
      "—",
    lastActive:
      (record.last_run_completion as string | undefined) ?? record.updated_at ?? undefined,
  };
}

export async function listAgents(conn: Connection): Promise<AgentSummary[]> {
  // SDK 0.3.0 management namespace (letta-agent-sdk#206) — works on both backends.
  const records = await sdkClient(conn).agents.list({
    limit: 50,
    orderBy: "lastRunCompletion",
    order: "desc",
  });
  return records.map(toSummary);
}

export async function createAgent(conn: Connection, options: { name: string; model: string; systemPrompt?: string }): Promise<string> {
  // Fixed in SDK 0.3.0 (letta-agent-sdk#209): cloud createAgent now hits the
  // production-compatible route, so both backends share the SDK path.
  const client = sdkClient(conn);
  return client.createAgent({
    name: options.name,
    model: options.model,
    // Explicit since SDK 0.5.4 (letta-agent-sdk#238): omitting personality no
    // longer implies "memo", it creates an agent with no preset identity or
    // memory blocks. This app makes chat agents, so it asks for the same
    // default Letta Code and Desktop use.
    personality: "memo",
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
  });
}

export async function updateAgent(conn: Connection, agentId: string, changes: { name?: string }): Promise<void> {
  await sdkClient(conn).agents.update(agentId, changes);
}

export async function deleteAgent(conn: Connection, agentId: string): Promise<void> {
  await sdkClient(conn).agents.delete(agentId);
}

// ── Execution targets ───────────────────────────────────────────────────────

/**
 * Pick where a cloud session should execute. If the account has an
 * environment (a `letta` listener) online right now, route the session there —
 * that's the "chat with the agent on my homeserver" case and avoids spinning
 * a sandbox. Otherwise return undefined and let the SDK manage a sandbox.
 */
export async function pickCloudEnvironment(conn: Connection): Promise<{ connectionId: string } | undefined> {
  if (conn.profile.type !== "cloud") return undefined;
  try {
    const body = (await cloudFetch(conn, "/v1/environments")) as {
      connections?: { id: string; lastSeenAt?: number }[];
    };
    const now = Date.now();
    const online = (body.connections ?? [])
      .filter((c) => typeof c.lastSeenAt === "number" && now - c.lastSeenAt! < 120_000)
      .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
    return online[0] ? { connectionId: online[0].id } : undefined;
  } catch {
    return undefined;
  }
}

// ── Profile pictures ────────────────────────────────────────────────────────

export interface AgentProfilePicture {
  /** Full data URL (data:image/png;base64,...) — renderable directly. */
  dataUrl: string;
  /** MemFS commit that produced the image — cache-revision key. */
  commitSha: string | null;
}

/**
 * The agent's profile picture (profile.png in the agent's MemFS). Not exposed
 * by the portable SDK — direct REST. Returns null when the agent has no
 * picture (403/404) or on any error: avatars are decoration and must never
 * surface as a failure.
 */
export async function fetchAgentProfilePicture(
  conn: Connection,
  agentId: string,
): Promise<AgentProfilePicture | null> {
  if (conn.profile.type !== "cloud") return null;
  try {
    const body = (await cloudFetch(
      conn,
      `/v1/agents/${encodeURIComponent(agentId)}/profile-picture`,
      { headers: { Accept: "application/json" } },
    )) as { data_url?: string; commit_sha?: string | null };
    if (!body?.data_url) return null;
    return { dataUrl: body.data_url, commitSha: body.commit_sha ?? null };
  } catch {
    // 403/404 = no picture set; any other error is swallowed for the same reason.
    return null;
  }
}

// ── Conversations ───────────────────────────────────────────────────────────

export interface ConversationSummary {
  id: string;
  title: string;
  lastMessageAt?: string;
}

/** Display projection of the SDK's LettaConversation record. */
function toConversation(record: LettaConversation): ConversationSummary {
  return {
    id: record.id,
    title: record.summary ?? "New conversation",
    lastMessageAt: record.last_message_at ?? record.updated_at ?? undefined,
  };
}

export async function listConversations(
  conn: Connection,
  agentId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<ConversationSummary[]> {
  const limit = opts.limit ?? 30;
  const records = await sdkClient(conn).conversations.list({
    agentId,
    limit,
    // Order by last activity. This matters beyond sorting: the API's default
    // list projection omits `summary` and `last_message_at` (every row renders
    // as "New conversation" / "no messages yet") and orders by creation time,
    // which floats empty auto-created conversations to the top. Requesting
    // last_message_at ordering returns hydrated records — real titles,
    // real timestamps, most-recently-active first — which is also the order
    // a chat app wants anyway.
    orderBy: "lastMessageAt",
    order: "desc",
    // The management API pages with an `after` cursor in sort order.
    ...(opts.before ? { after: opts.before } : {}),
  });
  return records.map(toConversation);
}

export async function createConversation(conn: Connection, agentId: string): Promise<string> {
  const conversation = await sdkClient(conn).conversations.create({ agentId });
  return conversation.id;
}

export async function renameConversation(conn: Connection, conversationId: string, title: string): Promise<void> {
  // The user-facing "title" is the conversation's `summary` field on the wire.
  await sdkClient(conn).conversations.update(conversationId, { summary: title });
}

/**
 * Deleting a conversation is cloud-only: the REST surface has
 * DELETE /v1/conversations/{id}, but the app-server protocol has no
 * conversation_delete command, so remote profiles must not offer the action.
 */
export function canDeleteConversations(conn: Connection): boolean {
  return conn.profile.type === "cloud";
}

export async function deleteConversation(conn: Connection, conversationId: string): Promise<void> {
  if (!canDeleteConversations(conn)) {
    throw new Error("This server doesn't support deleting conversations.");
  }
  await cloudFetch(conn, `/v1/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
}

/** One page of conversation history plus the cursor to the next older page. */
export interface ConversationMessagesPage {
  /** Oldest-first, ready for the transcript. */
  messages: unknown[];
  /** `before` cursor for the next older page; null when exhausted. */
  nextBefore: string | null;
  hasMore: boolean;
}

/**
 * Conversation history over REST/protocol — no SDK session required, so
 * browsing a conversation never spins up an execution sandbox.
 */
export async function listConversationMessages(
  conn: Connection,
  conversationId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<ConversationMessagesPage> {
  const limit = opts.limit ?? 50;
  const result = await sdkClient(conn).conversations.listMessages(conversationId, {
    limit,
    // `before` means older on both backends since SDK 0.6.1 (letta-agent-sdk#249
    // normalizes the cloud REST API's order-relative cursors), so the
    // per-backend branch this used to need is gone.
    ...(opts.before ? { before: opts.before } : {}),
  });
  // Newest-first from the API; the transcript renders oldest-first.
  const messages = [...result.messages].reverse();
  // App-servers answer without nextBefore/hasMore, so page from the oldest id
  // we hold — the same cursor style listConversations() uses. A short page
  // means we reached the beginning.
  const oldestId = (messages[0] as { id?: string } | undefined)?.id ?? null;
  const full = result.messages.length >= limit;
  return {
    messages,
    nextBefore: result.nextBefore ?? (full ? oldestId : null),
    hasMore: result.hasMore ?? full,
  };
}

/** Current model + effort for one conversation (falls back to the agent's). */
export async function getConversationModel(
  conn: Connection,
  conversationId: string,
): Promise<{ model: string | null; reasoningEffort: string | null; title: string | null }> {
  const body: LettaConversation = await sdkClient(conn).conversations.retrieve(conversationId);
  // model_settings is an open record on the SDK type; narrow the fields we read.
  const s = body.model_settings as {
    reasoning_effort?: string | null;
    effort?: string | null;
    thinking?: { type?: string } | null;
  } | null;
  // Providers normalize effort differently: OpenAI keeps reasoning_effort/
  // effort; Anthropic converts it into a thinking budget.
  const effort =
    s?.reasoning_effort ?? s?.effort ?? (s?.thinking?.type === "enabled" ? "thinking" : null);
  return {
    model: body.model ?? null,
    reasoningEffort: effort,
    // `summary` IS the user-facing title on the wire; the generated client type
    // (SDK 0.5.2 routes through @letta-ai/letta-client) has no `title` field.
    title: body.summary ?? null,
  };
}

/**
 * Set the conversation-scoped model (and optional reasoning effort). Writes
 * through REST/protocol so it works without an open session; an active SDK
 * session picks the change up on its next turn.
 */
export async function updateConversationModel(
  conn: Connection,
  conversationId: string,
  change: { model: string; reasoningEffort?: ReasoningEffort },
): Promise<void> {
  const modelSettings = modelSettingsFor(change.model, change.reasoningEffort);
  await sdkClient(conn).conversations.update(conversationId, {
    model: change.model,
    ...(modelSettings ? { modelSettings } : {}),
  });
}

/** The `model_settings` union the API accepts, keyed by provider. */
type ModelSettings = NonNullable<UpdateConversationOptions["modelSettings"]>;

/**
 * Effort is spelled differently per provider — Anthropic takes a top-level
 * `effort` (and has no none/minimal tier, but does have `max`), while OpenAI
 * nests it as `reasoning.reasoning_effort`. The provider comes from the handle
 * prefix ("anthropic/claude-…"). Providers we don't model send the model change
 * alone rather than a guessed payload the server would reject.
 */
function modelSettingsFor(model: string, effort?: ReasoningEffort): ModelSettings | undefined {
  if (!effort) return undefined;
  const provider = model.includes("/") ? model.split("/")[0] : undefined;
  if (provider === "anthropic") {
    const anthropicEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
    type AnthropicEffort = (typeof anthropicEfforts)[number];
    return anthropicEfforts.includes(effort as AnthropicEffort)
      ? { provider_type: "anthropic", effort: effort as AnthropicEffort }
      : undefined;
  }
  if (provider === "openai") {
    return { provider_type: "openai", reasoning: { reasoning_effort: effort } };
  }
  return undefined;
}

// ── Models ──────────────────────────────────────────────────────────────────

export async function listModels(conn: Connection): Promise<ModelOption[]> {
  // Session-less on every backend since SDK 0.3.1 — no sandbox just to open a picker.
  const result = await sdkClient(conn).models.list();
  return result.entries.map((e) => ({ id: e.id, handle: e.handle, label: e.label }));
}
