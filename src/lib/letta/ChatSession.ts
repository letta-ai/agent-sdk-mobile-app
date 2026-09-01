/**
 * ChatSession — the bridge between the Agent SDK and the UI's ChatSnapshot.
 *
 * This is the file to read to learn the SDK: it opens a session for a
 * conversation (cloud or remote), hydrates history via listMessages(),
 * consumes the session.stream() generator, and reduces every SDKMessage into
 * the same immutable snapshot vocabulary the mock transport produces — so the
 * UI can't tell them apart. State is server-authoritative throughout: run
 * phase, queue order, and errors all come from the stream, never local guesses.
 */
import type {
  TranscriptAccumulator,
  TranscriptRow,
  CanUseToolContext,
  CanUseToolPermissionSuggestion,
  LettaCodeSession,
  SDKMessage,
  SessionDeviceStatus,
} from "@letta-ai/letta-agent-sdk/client";
import { createTranscriptAccumulator } from "@letta-ai/letta-agent-sdk/client";

import { toImageContent, type Attachment } from "./attachments";
import type { Profile } from "../profiles/profiles";
import { getConversationModel, isAuthError, listConversationMessages, sdkClient } from "./api";
import { emptyChat, type ApprovalRequest, type ChatSnapshot, type PermissionMode, type ToolStatus, type TranscriptItem } from "./model";
import { patch } from "./mockSession";
import { contentToText, formatToolInput } from "./toolText";
import { newestTextKey, projectRows, type ProjectionState } from "./transcriptProjection";

export type SnapshotListener = (snapshot: ChatSnapshot) => void;

/**
 * Steady-state delta flush interval. Wire chunks arrive far faster than the
 * UI can usefully paint them; committing each one re-renders every visible
 * row. The references coalesce the same way (remodex 80ms steady tier,
 * paseo 48ms) — the first delta of a burst still commits immediately.
 */
const STREAM_FLUSH_MS = 80;

/**
 * How long a resolved approval waits for evidence the decision reached the
 * server. The SDK sends the approval_response fire-and-forget, so subsequent
 * stream traffic is the closest confirmation available (paseo's
 * respondToPermissionAndWait uses the same 15s bound).
 */
const APPROVAL_CONFIRM_TIMEOUT_MS = 15000;

/**
 * How long a reconnect may run before it announces itself. A resume resync
 * usually settles in well under this, and flashing "Reconnecting…" over a
 * healthy screen on every app switch reads as flakiness (paseo gates resume
 * revalidation the same way).
 */
const RECONNECT_BANNER_DELAY_MS = 400;

/**
 * Live activity for conversations this device currently has open, so list rows
 * can show a running / needs-you dot. Deliberately device-local: the server's
 * conversation records carry no run state, so a row is only ever marked from a
 * session this app opened (references scope it the same way).
 */
export type ConversationActivity = "running" | "awaiting_approval";

const activityByConversation = new Map<string, ConversationActivity>();
const activityListeners = new Set<() => void>();

function publishActivity(conversationId: string, activity: ConversationActivity | null): void {
  const previous = activityByConversation.get(conversationId) ?? null;
  if (previous === activity) return;
  if (activity) activityByConversation.set(conversationId, activity);
  else activityByConversation.delete(conversationId);
  for (const listener of activityListeners) listener();
}

export function conversationActivity(conversationId: string): ConversationActivity | null {
  return activityByConversation.get(conversationId) ?? null;
}

/** Subscribe to activity changes; returns an unsubscribe. */
export function subscribeConversationActivity(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
}

export class ChatSession {
  /**
   * Run-completion callback for system notifications: fires once per turn —
   * local result frames and external-run loop_status idle transitions alike.
   */
  onRunCompleted: ((success: boolean, isExternal: boolean) => void) | null = null;
  private externalRunActive = false;

  private conn: { profile: Profile; secret: string };
  private conversationId: string;
  private session: LettaCodeSession | null = null;
  private snapshot: ChatSnapshot;
  private listeners = new Set<SnapshotListener>();
  private closed = false;
  /** Set when the stream errored terminally; reconnect() replaces the session. */
  private sessionDead = false;
  /**
   * Row identity, delta accumulation, replay suppression and backfill merging
   * all belong to the SDK's accumulator (letta-agent-sdk#274). What stays here
   * is presentation: which row is live, how long a think took, tool statuses the
   * approval flow owns, and rows the server has never seen.
   */
  private accumulator: TranscriptAccumulator = createTranscriptAccumulator();
  /**
   * Rows no server message can produce (an echo still in flight, an error),
   * each anchored to the number of accumulator rows that existed when it was
   * created — so it renders where it happened instead of floating to the end
   * once the reply streams in.
   */
  private localRows: { anchor: number; item: TranscriptItem }[] = [];
  /** otids of echoes still awaiting their persisted counterpart. */
  private echoOtids = new Set<string>();
  /** Reasoning think time, keyed by accumulator row key. */
  private thinkStartedAt = new Map<string, number>();
  private thinkSeconds = new Map<string, number>();
  private toolStartedAt = new Map<string, number>();
  private toolDurationMs = new Map<string, number>();
  /** awaiting_approval / denied — states only the approval flow knows about. */
  private toolStatusOverride = new Map<string, ToolStatus>();
  /** Row the last turn left unfinished, rendered as "Stopped". */
  private interruptedKey: string | null = null;
  /** Cursor to the next older history page. */
  private nextBefore: string | null = null;
  private pendingStream: SDKMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private counter = 0;
  /** Attachments behind pending local echoes, so retry re-sends the images too. */
  private pendingAttachments = new Map<string, Attachment[]>();
  private approvalResolvers = new Map<
    string,
    (response: { behavior: "allow" } | { behavior: "deny"; message: string }) => void
  >();
  /** Resolved approvals waiting for post-decision stream traffic. */
  private activityWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();

  private constructor(conn: { profile: Profile; secret: string }, conversationId: string) {
    this.conn = conn;
    this.conversationId = conversationId;
    this.snapshot = { ...emptyChat, hydrating: true };
  }

  /**
   * Open a chat: history hydrates over REST immediately (free — no execution
   * environment), and the SDK session opens lazily on the first send. Opening
   * a cloud session provisions a sandbox, which is too heavy to pay for just
   * reading a conversation (see SDK-FEEDBACK.md #3).
   */
  static open(conn: { profile: Profile; secret: string }, conversationId: string): ChatSession {
    const chat = new ChatSession(conn, conversationId);
    void chat.hydrate();
    return chat;
  }

  /** Create the SDK session on demand and start consuming its stream. */
  private ensureSession(): LettaCodeSession {
    if (this.session) return this.session;
    const client = sdkClient(this.conn);
    // Cloud sessions execute in an SDK-managed sandbox (the SDK default).
    // TODO(sdk) BUG: routing to an online environment via
    // resumeSession(id, { environment }) fails against production — cloud-api
    // closes the status socket with 1013 "Listener connection unavailable"
    // when the SDK sends runtime_start, even with the listener online (see
    // SDK-FEEDBACK.md). Re-enable pickCloudEnvironment() once fixed.
    this.session = client.resumeSession(this.conversationId, {
      // Tool approvals surface as an ApprovalRequest in the snapshot; the
      // ApprovalCard resolves it via resolveApproval(). The run stays in
      // awaiting_approval until the user decides.
      // TODO(sdk): the callback only receives (toolName, toolInput) — the
      // wire protocol's permission_suggestions, diffs, and tool_call_id
      // never reach it (SDK-FEEDBACK.md #4).
      canUseTool: (toolName, toolInput, context) =>
        this.requestApproval(toolName, toolInput, context),
    });
    // Safe alongside the other first calls: initialize is single-flight since
    // SDK 0.3.2 (#214), and since 0.5.0 (#218) the app-server serves
    // concurrent clients, so nothing here contends for a socket.
    void this.consume();
    this.watchDeviceStatus(this.session);
    return this.session;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  current(): ChatSnapshot {
    return this.snapshot;
  }

  async send(text: string, attachments: Attachment[] = []): Promise<void> {
    // Stamp the echo with the otid we hand to send() (SDK 0.7.0,
    // letta-agent-sdk#273): the persisted user message comes back under the same
    // otid, so the accumulator keys it to this row and the echo retires by
    // identity instead of being guessed at.
    const otid = `echo-${this.conversationId}-${Date.now()}-${this.counter++}`;
    this.echoOtids.add(otid);
    this.commit(
      this.appendLocal(this.snapshot, {
        kind: "user",
        id: otid,
        text,
        pending: true,
        ...(attachments.length > 0 ? { images: attachments.map((a) => a.uri) } : {}),
      }),
    );
    if (attachments.length > 0) this.pendingAttachments.set(otid, attachments);
    // The turn starts when the user sends; loop_status and the device's own
    // status stay authoritative from here.
    if (this.snapshot.run === "idle") this.commit(patch(this.snapshot, { run: "running" }));
    try {
      // The SDK takes either a string or a multimodal content array; images
      // lead so the model reads them as context for the instruction.
      await this.ensureSession().send(
        attachments.length > 0
          ? [...toImageContent(attachments), ...(text ? [{ type: "text" as const, text }] : [])]
          : text,
        { otid },
      );
    } catch (e) {
      // Session init/send failed (e.g. sandbox unavailable): mark the echo
      // failed and surface the reason — never leave a silently-pending bubble.
      // Fully handled here (no re-throw): the failed bubble + error row ARE
      // the error report, and composer call sites fire-and-forget.
      this.markEcho(otid, { failed: true });
      this.commit(
        this.appendError(
          patch(this.project(this.snapshot), { run: "idle" }),
          e instanceof Error ? e.message : "Send failed.",
        ),
      );
      return;
    }
    this.pendingAttachments.delete(otid);
    this.markEcho(otid, { pending: false });
    this.commit(this.project(this.snapshot));
  }

  /** Update an in-flight echo in place (pending -> sent, or failed). */
  private markEcho(otid: string, changes: { pending?: boolean; failed?: boolean }): void {
    this.localRows = this.localRows.map((row) =>
      row.item.kind === "user" && row.item.id === otid
        ? {
            ...row,
            item: { ...row.item, ...changes, ...(changes.pending === false ? { pending: undefined } : {}) },
          }
        : row,
    );
  }

  /** Re-send a failed bubble: drop it (and its error row) and send fresh. */
  async retrySend(itemId: string): Promise<void> {
    const items = this.snapshot.transcript;
    const index = items.findIndex((t) => t.id === itemId);
    const item = items[index];
    if (!item || item.kind !== "user" || !item.failed) return;
    // The error row committed alongside the failure sits right after it.
    const next = items[index + 1];
    const dropError = next?.kind === "error";
    this.commit({
      ...this.snapshot,
      transcript: items.filter((_t, i) => i !== index && !(dropError && i === index + 1)),
    });
    const images = this.pendingAttachments.get(itemId) ?? [];
    this.pendingAttachments.delete(itemId);
    await this.send(item.text, images);
  }

  /** Called by the SDK when a tool needs permission; resolved by the UI. */
  private requestApproval(
    toolName: string,
    toolInput: Record<string, unknown>,
    // SDK 0.3.1 (letta-agent-sdk#210): suggestions, diffs, and the tool call
    // id now arrive with the request, so the card can offer suggestion chips
    // and link itself to its tool row.
    context?: CanUseToolContext,
  ): Promise<{ behavior: "allow"; updatedPermissions?: unknown[] } | { behavior: "deny"; message: string }> {
    const requestId = context?.requestId ?? this.id("approval");
    const request: ApprovalRequest = {
      requestId,
      toolCallId: context?.toolCallId ?? requestId,
      toolName,
      summary: `Run ${toolName}`,
      // The user is deciding on this payload — it must be complete, never the
      // one-line summary (a hidden `&& rm -rf` past a truncation point is the
      // threat model approvals exist for).
      input: formatToolInput(toolInput) ?? JSON.stringify(toolInput),
      permissionSuggestions: (context?.permissionSuggestions ?? []).map((p) => ({
        id: p.id,
        text: p.text,
      })),
    };
    // The originating tool card must stop shimmering while the run is blocked
    // on the user (design-doc.md: awaiting-approval shows on the card, not
    // just in the composer slot the keyboard can cover).
    this.commit(
      patch(this.setToolStatus(this.snapshot, request.toolCallId, "awaiting_approval"), {
        approvals: [...this.snapshot.approvals, request],
        run: "awaiting_approval",
      }),
    );
    return new Promise((resolve) => {
      this.approvalResolvers.set(requestId, resolve);
    });
  }

  /**
   * UI decision for a pending approval. Accepting a server permission
   * suggestion allows the call AND persists the suggested rule via
   * updatedPermissions.
   *
   * The request stays in the snapshot (the card shows its submitting state)
   * until post-decision stream traffic confirms the session is alive, or the
   * confirmation window lapses — the SDK sends the decision fire-and-forget,
   * so this is the only honesty available (design-doc.md §4.4: "the card
   * leaves only on server confirmation").
   */
  async resolveApproval(
    requestId: string,
    decision: "allow" | "deny",
    reason?: string,
    acceptedSuggestionId?: string,
  ): Promise<void> {
    const resolve = this.approvalResolvers.get(requestId);
    if (!resolve) return;
    this.approvalResolvers.delete(requestId);
    const request = this.snapshot.approvals.find((a) => a.requestId === requestId);
    if (request) {
      // Duration measures execution, not how long the user deliberated: the
      // clock restarts on allow and is dropped on deny (the tool never ran).
      if (decision === "allow") this.toolStartedAt.set(request.toolCallId, Date.now());
      else this.toolStartedAt.delete(request.toolCallId);
      // The card's status must settle before the decision resolves: a denial
      // still yields an error tool_result, and the reducer keeps "denied"
      // only when it's already painted.
      this.commit(
        this.setToolStatus(this.snapshot, request.toolCallId, decision === "deny" ? "denied" : "running"),
      );
    }
    if (decision === "deny") {
      resolve({ behavior: "deny", message: reason?.trim() || "Denied from the mobile app" });
    } else {
      const suggestion = acceptedSuggestionId
        ? request?.permissionSuggestions.find((p) => p.id === acceptedSuggestionId)
        : undefined;
      resolve({
        behavior: "allow",
        ...(suggestion ? { updatedPermissions: [suggestion satisfies CanUseToolPermissionSuggestion] } : {}),
      });
    }
    let delivered = true;
    try {
      await this.awaitStreamActivity(APPROVAL_CONFIRM_TIMEOUT_MS);
    } catch {
      delivered = false;
    }
    if (this.closed) return;
    const approvals = this.snapshot.approvals.filter((a) => a.requestId !== requestId);
    if (delivered) {
      // The turn may have settled while we waited (loop_status idle is a
      // valid confirmation) — never resurrect "running" over it.
      const run =
        approvals.length > 0
          ? ("awaiting_approval" as const)
          : this.snapshot.run === "awaiting_approval"
            ? ("running" as const)
            : this.snapshot.run;
      this.commit(patch(this.snapshot, { approvals, run }));
      return;
    }
    // The stream died while waiting: consume() already owns run/connection —
    // only retire the card and say the decision may be lost. Fully handled
    // here (no throw): the error row IS the report, and the caller only
    // clears its submitting state.
    this.commit(
      patch(this.appendError(this.snapshot, "The session dropped — your decision may not have reached the agent."), {
        approvals,
      }),
    );
  }

  /**
   * Settles on the next ingested stream message — any traffic after the
   * decision hand-off proves the socket is alive, the closest confirmation a
   * fire-and-forget approval_response allows. A silent-but-healthy stream
   * (long tool run) settles at the timeout; only a stream error rejects.
   */
  private awaitStreamActivity(timeoutMs: number): Promise<void> {
    if (this.sessionDead || !this.session) return Promise.reject(new Error("Session unavailable"));
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.activityWaiters.delete(waiter);
        resolve();
      }, timeoutMs);
      this.activityWaiters.add(waiter);
    });
  }

  private settleActivityWaiters(error?: Error): void {
    const waiters = [...this.activityWaiters];
    this.activityWaiters.clear();
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve();
    }
  }

  /**
   * Current conversation model + effort, read through this session's own
   * connection (remote app-servers accept one control client, so a separate
   * connection would conflict with the session).
   */
  async getModelInfo(): Promise<{ model: string | null; reasoningEffort: string | null; title: string | null }> {
    // Plain management call again: since SDK 0.5.0 / letta-code 0.29.7
    // (letta-agent-sdk#218, letta-code#3524) an app-server serves management
    // requests and live sessions concurrently, so this no longer has to be
    // hand-rolled through the session's own socket to avoid evicting it.
    return getConversationModel(this.conn, this.conversationId);
  }

  /** Change the conversation model/effort through the session (first-class SDK API). */
  async setModel(model: string, reasoningEffort?: string): Promise<void> {
    await this.ensureSession().updateModel({
      modelHandle: model,
      ...(reasoningEffort ? { reasoningEffort: reasoningEffort as never } : {}),
    });
  }

  /** Change the runtime permission mode (SDK 0.3.0 #208 write, 0.3.1 #212 read). */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.ensureSession().changeDeviceState({ permissionMode: mode });
    // The authoritative value lands via the next device-status update; show
    // the pending value immediately so the sheet feels responsive.
    this.commit(
      patch(this.snapshot, {
        device: {
          permissionMode: mode,
          workingDirectory: this.snapshot.device?.workingDirectory ?? null,
          memoryDirectory: this.snapshot.device?.memoryDirectory ?? null,
        },
      }),
    );
  }

  /** Mirror live device status (permission mode, cwd) into the snapshot. */
  private watchDeviceStatus(session: LettaCodeSession): void {
    session.onDeviceStatus((status) => this.commit(this.applyDeviceStatus(this.snapshot, status)));
    void session.getDeviceStatus().catch(() => {
      // Best-effort: some transports may not replay status until a turn runs.
    });
  }

  /**
   * The device owns the truth about whether a turn is running and which
   * approvals it is blocked on, so its status reconciles our in-memory guess.
   * Without this a resume can leave the UI stuck ("Running" forever, stop
   * button frozen) after the run it remembers has long since finished.
   */
  private applyDeviceStatus(snapshot: ChatSnapshot, status: SessionDeviceStatus): ChatSnapshot {
    const pending = status.pendingControlRequests ?? [];
    // Approvals we still hold a resolver for stay as they are — those cards can
    // be acted on. Ones the device reports but we can't answer (resolvers died
    // with the previous process) are surfaced read-only so the user at least
    // knows why the turn is stalled, and recoverPendingApprovals() re-delivers
    // them through canUseTool with fresh resolvers.
    const answerable = snapshot.approvals.filter((a) => this.approvalResolvers.has(a.requestId));
    const orphans = pending
      .filter((p) => !answerable.some((a) => a.requestId === p.requestId))
      .map((p) => ({
        requestId: p.requestId,
        toolCallId: (p as { toolCallId?: string }).toolCallId ?? p.requestId,
        toolName: p.toolName,
        summary: `Run ${p.toolName}`,
        input: "",
        permissionSuggestions: [],
        unresolvable: true,
      }));
    const approvals = [...answerable, ...orphans];
    return patch(snapshot, {
      device: {
        permissionMode: status.permissionMode as PermissionMode,
        workingDirectory: status.workingDirectory,
        // The path the executing harness actually resolved (SDK 0.5.1, #229) —
        // null on older servers that don't report it.
        memoryDirectory: status.memoryDirectory,
      },
      approvals,
      // Never downgrade a locally-known abort in flight; otherwise the device
      // decides. An unanswered approval outranks "running" for the composer.
      run:
        snapshot.run === "aborting"
          ? "aborting"
          : approvals.length > 0
            ? "awaiting_approval"
            : status.isProcessing
              ? "running"
              : "idle",
    });
  }

  /**
   * Remove a queued follow-up. The item shows as pending until the server's
   * next `queue_update` confirms the removal (never removed optimistically).
   * First-class in SDK 0.3.0 (letta-agent-sdk#208).
   */
  async removeQueueItem(itemId: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.commit(
      patch(this.snapshot, {
        queue: this.snapshot.queue.map((q) => (q.id === itemId ? { ...q, pendingRemoval: true } : q)),
      }),
    );
    await session.removeQueuedMessage(itemId);
  }

  /**
   * Foreground resume / retry: re-hydrate authoritative history over REST and
   * clear the offline banner if it succeeds. A live session keeps its own
   * socket; if it died, the next send() lazily opens a fresh one.
   */
  async reconnect(): Promise<void> {
    // A visible failure state means the user pressed Retry — acknowledge
    // instantly. Otherwise hold the "reconnecting" commit briefly so a fast
    // resume resync never flashes the banner over a healthy screen.
    let pending: ReturnType<typeof setTimeout> | null = null;
    if (this.snapshot.connection === "offline" || this.snapshot.connection === "auth_failed") {
      this.commit(patch(this.snapshot, { connection: "reconnecting" }));
    } else {
      pending = setTimeout(() => {
        pending = null;
        this.commit(patch(this.snapshot, { connection: "reconnecting" }));
      }, RECONNECT_BANNER_DELAY_MS);
    }
    const ok = await this.hydrate();
    if (pending) clearTimeout(pending);
    // On failure hydrate() already committed offline/auth_failed.
    if (!ok || this.closed) return;
    // A dead session object can't be reused; drop it so send() reopens.
    if (this.sessionDead) {
      this.session?.close();
      this.session = null;
      this.sessionDead = false;
    }
    this.commit(patch(this.snapshot, { connection: "connected" }));
  }

  async abort(): Promise<void> {
    // With no live session there is no server to confirm the abort, so
    // "aborting" could never retire — nothing runs client-side anyway.
    if (!this.session || this.sessionDead) {
      this.commit(patch(this.snapshot, { run: "idle" }));
      return;
    }
    const previous = this.snapshot.run;
    this.commit(patch(this.snapshot, { run: "aborting" }));
    try {
      await this.session.abort();
    } catch (e) {
      this.commit(
        patch(this.appendError(this.snapshot, e instanceof Error ? e.message : "Couldn't stop the run."), {
          run: previous,
        }),
      );
    }
  }

  close(): void {
    this.closed = true;
    this.accumulator.reset();
    this.localRows = [];
    this.echoOtids.clear();
    publishActivity(this.conversationId, null);
    this.settleActivityWaiters(new Error("Session closed"));
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.pendingStream = [];
    this.session?.close();
    this.listeners.clear();
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private commit(next: ChatSnapshot): void {
    this.snapshot = next;
    publishActivity(
      this.conversationId,
      next.approvals.length > 0
        ? "awaiting_approval"
        : next.run === "running" || next.run === "aborting"
          ? "running"
          : null,
    );
    for (const listener of this.listeners) listener(next);
  }

  private id(prefix: string): string {
    return `${prefix}-${this.counter++}`;
  }

  /**
   * Load existing history before any turn runs.
   *
   * Cloud: over REST — opening a cloud session provisions a sandbox, far too
   * heavy for just reading (SDK-FEEDBACK.md #3).
   * Remote: through the session itself — remote sessions are cheap, and the
   * app-server accepts only ONE control-channel client per process, so using
   * the SDK's management transport here would hold the slot and deadlock the
   * session's own connect (SDK-FEEDBACK.md "Still open" #4).
   */
  private async hydrate(): Promise<boolean> {
    try {
      if (this.conn.profile.type === "remote") {
        // Survive React dev double-mounting: the first, immediately-closed
        // instance must not open sockets, or its teardown races the second
        // instance for the app-server's single control slot.
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (this.closed) return false;
      }
      const page = await this.fetchHistoryPage();
      this.nextBefore = page.nextBefore;
      // rebase() merges history with replace semantics and is safe mid-run: it
      // lands rows on their existing keys instead of duplicating, and raises the
      // replay thresholds the page proves. Appending would double the transcript
      // on every foreground resume, which is exactly what it used to do.
      this.accumulator.rebase({ messages: page.messages as never }, { order: "asc" });
      this.commit(
        this.project(patch(this.snapshot, { hydrating: false, hasMore: page.hasMore })),
      );
      // An approval left pending across a disconnect (or a previous app run)
      // re-delivers through canUseTool, resurfacing the ApprovalCard instead
      // of deadlocking the run. Best-effort: older servers lack the command,
      // and cloud sessions don't exist until the first send.
      void this.session?.recoverPendingApprovals().catch(() => {});
      // Reconcile run phase + pending approvals with the device: an in-memory
      // "running" from before the resume is a guess, and a stale one freezes
      // the composer on stop with no way back.
      void this.session
        ?.getDeviceStatus()
        .then((status) => {
          if (!this.closed) this.commit(this.applyDeviceStatus(this.snapshot, status));
        })
        .catch(() => {});
      return true;
    } catch (e) {
      if (this.closed) return false;
      // A failed load must leave a live affordance behind: the retryable row
      // and the offline banner's Retry both route back through reconnect().
      this.commit(
        patch(
          this.appendError(this.snapshot, e instanceof Error ? e.message : "Couldn't load history.", true),
          {
            hydrating: false,
            connection: isAuthError(e) ? "auth_failed" : "offline",
          },
        ),
      );
      return false;
    }
  }

  /**
   * Fetch the next older history page and prepend it — the visual top of the
   * inverted transcript. Server-driven cursor; no-op while one is in flight.
   */
  async loadOlder(): Promise<void> {
    if (this.snapshot.hydrating || this.snapshot.loadingOlder) return;
    if (!this.snapshot.hasMore || !this.nextBefore) return;
    this.commit(patch(this.snapshot, { loadingOlder: true }));
    try {
      const page = await this.fetchHistoryPage(this.nextBefore);
      this.nextBefore = page.nextBefore;
      // Backfilled rows order ahead of live-only rows inside the accumulator.
      this.accumulator.rebase({ messages: page.messages as never }, { order: "asc" });
      this.commit(
        this.project(patch(this.snapshot, { hasMore: page.hasMore, loadingOlder: false })),
      );
    } catch {
      // A failed page is now assumed transient (the cursor itself works), so
      // hasMore stays set and scrolling back to the top retries.
      this.commit(patch(this.snapshot, { loadingOlder: false }));
    }
  }

  /** One page of history, oldest-first, with the cursor to the next older page. */
  private async fetchHistoryPage(before?: string): Promise<{ messages: unknown[]; nextBefore: string | null; hasMore: boolean }> {
    // Both backends page reliably now (letta-cloud#13377 + letta-code#3526), so
    // the first paint stays cheap and older pages arrive on scroll.
    const limit = 50;
    if (this.conn.profile.type === "remote") {
      const result = await this.ensureSession().listMessages({ limit, ...(before ? { before } : {}) });
      const messages = result.messages.slice().reverse();
      const oldestId = (messages[0] as { id?: string } | undefined)?.id ?? null;
      const full = result.messages.length >= limit;
      return {
        messages,
        nextBefore: result.nextBefore ?? (full ? oldestId : null),
        hasMore: result.hasMore ?? full,
      };
    }
    return listConversationMessages(this.conn, this.conversationId, { limit, ...(before ? { before } : {}) });
  }

  private async consume(): Promise<void> {
    try {
      const session = this.session;
      if (!session) return;
      // The SDK stream covers one turn and returns after its result. Open the
      // next stream immediately so later sends use the same live session.
      while (!this.closed && this.session === session) {
        let received = false;
        for await (const message of session.stream()) {
          if (this.closed) break;
          received = true;
          this.ingest(message as SDKMessage);
        }
        // A stream with no message means the SDK session itself closed. Route
        // that closure through the normal recovery path instead of retaining a
        // session object that no consumer reads.
        if (!received) throw new Error("Session stream closed.");
      }
    } catch (e) {
      if (this.closed) return;
      this.sessionDead = true;
      this.settleActivityWaiters(e instanceof Error ? e : new Error("Stream ended unexpectedly."));
      // No streaming visual may outlive the stream (the caret would pulse on
      // dead text forever — nothing else retires it after this point).
      this.interruptedKey = newestTextKey(this.accumulator.rows());
      const swept = this.project(this.drainStreamBuffer(this.snapshot));
      const detail = e instanceof Error && e.message ? e.message : "Stream ended unexpectedly.";
      this.commit(
        patch(isTransportError(detail) ? swept : this.appendError(swept, detail, true), {
          run: "idle",
          connection: isAuthError(e) ? "auth_failed" : "offline",
        }),
      );
    }
  }

  /**
   * Decouple wire cadence from render cadence: text deltas coalesce behind a
   * short flush so a fast model doesn't force a full-list render per chunk,
   * while everything discrete (tool cards, approvals, run phase, queue)
   * commits immediately — interactivity must never wait on the buffer.
   */
  private ingest(message: SDKMessage): void {
    this.settleActivityWaiters();
    if (message.type === "stream_event") {
      this.pendingStream.push(message);
      if (this.flushTimer) return;
      // Leading edge: the first token after silence paints instantly.
      this.flushStreamBuffer();
      this.armFlushTimer();
      return;
    }
    this.commit(this.reduce(this.drainStreamBuffer(this.snapshot), message));
  }

  private armFlushTimer(): void {
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.pendingStream.length === 0) return;
      this.flushStreamBuffer();
      this.armFlushTimer();
    }, STREAM_FLUSH_MS);
  }

  private flushStreamBuffer(): void {
    if (this.pendingStream.length === 0) return;
    this.commit(this.drainStreamBuffer(this.snapshot));
  }

  /** Reduce all held-back deltas onto `snapshot` without committing. */
  private drainStreamBuffer(snapshot: ChatSnapshot): ChatSnapshot {
    const events = this.pendingStream;
    this.pendingStream = [];
    let next = snapshot;
    for (const event of events) next = this.reduce(next, event);
    return next;
  }

  /**
   * Build the transcript the UI renders: the accumulator's rows in order,
   * projected into this app's vocabulary, followed by rows the server has never
   * seen (an echo still in flight, an error). An echo disappears the moment the
   * accumulator reports the persisted message under the same otid.
   */
  private project(snapshot: ChatSnapshot): ChatSnapshot {
    const rows = this.accumulator.rows();
    const running = snapshot.run === "running" || snapshot.run === "awaiting_approval";
    const liveKey = running ? newestTextKey(rows) : null;
    this.recordTimings(rows, liveKey);

    const state: ProjectionState = {
      liveKey,
      interruptedKey: this.interruptedKey,
      toolStatusOverride: this.toolStatusOverride,
      thinkStartedAt: this.thinkStartedAt,
      thinkSeconds: this.thinkSeconds,
      toolDurationMs: this.toolDurationMs,
    };
    const items = projectRows(rows, state);

    // An echo retires the moment the accumulator reports the persisted message
    // under the same otid — identity, not a guess about matching text.
    const seenOtids = new Set(rows.map((row) => row.otid).filter(Boolean) as string[]);
    this.localRows = this.localRows.filter(
      ({ item }) => !(item.kind === "user" && this.echoOtids.has(item.id) && seenOtids.has(item.id)),
    );

    const transcript: TranscriptItem[] = [];
    let placed = 0;
    for (let i = 0; i <= items.length; i++) {
      for (const { anchor, item } of this.localRows) {
        if (anchor === i) transcript.push(item);
      }
      if (i < items.length) transcript.push(items[i]!);
      placed = i;
    }
    // Anchors past the current row count (rows the accumulator later dropped)
    // still belong at the end rather than disappearing.
    for (const { anchor, item } of this.localRows) {
      if (anchor > placed) transcript.push(item);
    }
    return patch(snapshot, { transcript });
  }

  /**
   * Durations are wall-clock, so they are stamped as rows appear and settle
   * rather than derived from the rows themselves.
   */
  private recordTimings(rows: readonly TranscriptRow[], liveKey: string | null): void {
    for (const row of rows) {
      if (row.kind === "reasoning") {
        if (!this.thinkStartedAt.has(row.key)) this.thinkStartedAt.set(row.key, Date.now());
        if (row.key !== liveKey && !this.thinkSeconds.has(row.key)) {
          const startedAt = this.thinkStartedAt.get(row.key)!;
          this.thinkSeconds.set(row.key, Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
        }
      } else if (row.kind === "tool_call") {
        if (!this.toolStartedAt.has(row.toolCallId)) this.toolStartedAt.set(row.toolCallId, Date.now());
        if (row.status === "complete" && !this.toolDurationMs.has(row.toolCallId)) {
          const startedAt = this.toolStartedAt.get(row.toolCallId)!;
          // A denied call's elapsed time measures the user deliberating, not work.
          if (this.toolStatusOverride.get(row.toolCallId) !== "denied") {
            this.toolDurationMs.set(row.toolCallId, Date.now() - startedAt);
          }
        }
      }
    }
  }

  /**
   * Approval outcomes are the only tool statuses the stream cannot express:
   * a denied call still returns an error tool_result, and "awaiting approval"
   * has no wire equivalent at all. They are held as an overlay the projection
   * applies over the accumulator's own status.
   */
  private setToolStatus(snapshot: ChatSnapshot, toolCallId: string, status: ToolStatus): ChatSnapshot {
    if (status === "running") this.toolStatusOverride.delete(toolCallId);
    else this.toolStatusOverride.set(toolCallId, status);
    return this.project(snapshot);
  }

  /** Feed a message to the accumulator, then rebuild the transcript from it. */
  private absorb(snapshot: ChatSnapshot, message: SDKMessage): ChatSnapshot {
    this.accumulator.apply(message);
    return this.project(snapshot);
  }

  /** Add an app-only row (echo, error) anchored at the current live edge. */
  private appendLocal(snapshot: ChatSnapshot, item: TranscriptItem): ChatSnapshot {
    this.localRows = [...this.localRows, { anchor: this.accumulator.rows().length, item }];
    return this.project(snapshot);
  }

  /** Consecutive identical failures (reconnect loops) must read as one event. */
  private appendError(snapshot: ChatSnapshot, message: string, retryable?: boolean): ChatSnapshot {
    const last = snapshot.transcript[snapshot.transcript.length - 1];
    if (last?.kind === "error" && last.message === message) return snapshot;
    return this.appendLocal(snapshot, {
      kind: "error",
      id: this.id("err"),
      message,
      ...(retryable ? { retryable: true } : {}),
    });
  }

  private reduce(snapshot: ChatSnapshot, message: SDKMessage): ChatSnapshot {
    switch (message.type) {
      case "init":
        // Session metadata (agent, model, tools) — NOT a turn starting. Opening
        // a conversation initializes a session for hydration, so treating this
        // as "running" made a freshly-opened chat claim a turn was in flight.
        return snapshot;

      // Identity, delta accumulation and replay suppression all live in the
      // accumulator now — these cases only mark the run as active.
      case "stream_event":
        return this.absorb(snapshot, message);

      case "assistant":
      case "reasoning":
        return this.absorb(snapshot, message);

      case "tool_call":
        this.toolStartedAt.set(message.toolCallId, Date.now());
        return this.absorb(snapshot, message);

      case "tool_result":
        return this.absorb(snapshot, message);

      case "queue_update":
        return patch(snapshot, {
          queue: message.queue.map((item) => ({ id: item.id, text: contentToText(item.content) })),
        });

      case "loop_status": {
        // Server vocabulary is SCREAMING_SNAKE and grows over time. The
        // WAITING_* family means the loop is parked — on the user, or on an
        // approval — not working; treating any non-"idle" string as running is
        // what used to make a freshly-opened chat show a phantom turn, since
        // opening one reports WAITING_ON_INPUT.
        const status = message.status.toUpperCase();
        // External-run completion: loop_status IDLE after foreign run traffic
        // is the only terminal signal external runs produce on this session.
        if (status !== "IDLE" && !status.startsWith("WAITING")) {
          this.externalRunActive = true;
        } else if (status === "IDLE" && this.externalRunActive) {
          this.externalRunActive = false;
          this.onRunCompleted?.(true, true);
        }
        if (status === "WAITING_ON_APPROVAL") {
          return this.project(patch(snapshot, { run: "awaiting_approval" }));
        }
        if (!status.startsWith("WAITING") && status !== "IDLE") {
          return this.project(patch(snapshot, { run: snapshot.run === "idle" ? "running" : snapshot.run }));
        }
        // Interruption is `result`'s call — a normal completion also lands here,
        // and marking the last row "Stopped" from this path would libel it.
        return this.project(patch(snapshot, { run: "idle" }));
      }

      case "result": {
        // An aborted turn completes as a result with stopReason "interrupted"
        // and no settled assistant message, so the row it left behind is the
        // only place "Stopped" can be shown.
        const interrupted = !message.success || message.stopReason === "interrupted";
        this.interruptedKey = interrupted ? newestTextKey(this.accumulator.rows()) : null;
        const idle = this.project(patch(snapshot, { run: "idle" }));
        this.onRunCompleted?.(message.success !== false, false);
        return message.success
          ? idle
          : this.appendError(idle, message.errorDetail ?? message.error ?? "The run failed.");
      }

      case "error":
        this.interruptedKey = newestTextKey(this.accumulator.rows());
        return this.appendError(
          this.project(snapshot),
          // Error events don't always carry a message (e.g. an
          // approval_conflict names only its code) — never render blank.
          message.message ||
            ((message as { code?: string }).code
              ? `The server rejected the request (${(message as { code?: string }).code}).`
              : "Something went wrong on the server."),
        );

      case "retry":
      default:
        return snapshot;
    }
  }
}



/** Restate one tool card's status; no-op when the call isn't in the transcript. */
/**
 * Transport-class failures are the ConnectionBanner's to report — a transcript
 * row would double-report and outlive the outage (remodex filters the same
 * classes out of its persistent footer error slot).
 */
function isTransportError(message: string): boolean {
  return /network|socket|connect|timed?\s?out|closed|unavailable|offline|interrupt|stream ended/i.test(message);
}

