/**
 * Chat — the product (docs/design-doc.md §4.4). A ChatSession bridges the
 * Agent SDK stream into the snapshot the transcript renders. The composer
 * stays enabled during a run (sends become queued follow-ups, server-
 * confirmed); the send button morphs into stop.
 */
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { router, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ApprovalCard } from "../components/chat/ApprovalCard";
import { ConnectionBanner } from "../components/chat/Banner";
import { ModelSheet } from "../components/chat/ModelSheet";
import { EnvironmentSheet } from "../components/chat/EnvironmentSheet";
import type { ComputerSummary } from "../lib/letta/api";
import { QueueCapsule } from "../components/chat/QueueCapsule";
import { QueueSheet } from "../components/chat/QueueSheet";
import {
  AssistantBlock,
  ErrorRow,
  ReasoningRow,
  ThinkingRow,
  ToolCard,
  ToolGroupRow,
  UserBubble,
} from "../components/chat/TranscriptRows";
import { ToolDetailSheet } from "../components/chat/ToolDetailSheet";
import { EmptyState } from "../components/ui/EmptyState";
import { Header, Screen } from "../components/ui/Screen";
import { Sheet } from "../components/ui/Sheet";
import { SkeletonList } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { Text } from "../components/ui/Text";
import { Touchable } from "../components/ui/Touchable";
import { haptic } from "../lib/haptics";
import { ChatSession } from "../lib/letta/ChatSession";
import {
  getConversationModel,
  isAuthError,
  listComputers,
  listModels,
  updateConversationModel,
  type ModelOption,
  type ReasoningEffort,
} from "../lib/letta/api";
import {
  emptyChat,
  type ChatSnapshot,
  type ConnectionPhase,
  type PermissionMode,
  type ToolItem,
} from "../lib/letta/model";
import { groupToolRuns, type TranscriptRowItem } from "../lib/letta/grouping";
import { pickImages, type Attachment } from "../lib/letta/attachments";
import { getSecret, saveProfile } from "../lib/profiles/profiles";
import { useProfiles } from "../lib/profiles/ProfilesContext";
import { useTheme } from "../theme/ThemeProvider";
import { motion, radius, space } from "../theme/tokens";

// Memoized so a streaming flush only re-renders the row whose item changed:
// upsertItem preserves untouched item identity, so reference equality holds.
const TranscriptRow = memo(function TranscriptRow({
  item,
  onUserRetry,
  onToolPress,
  onErrorRetry,
  onToggleGroup,
}: {
  item: TranscriptRowItem;
  onUserRetry?: (id: string) => void;
  onToolPress?: (id: string) => void;
  onErrorRetry?: () => void;
  onToggleGroup?: (id: string) => void;
}) {
  switch (item.kind) {
    case "toolGroup":
      return (
        <ToolGroupRow group={item} onToggle={() => onToggleGroup?.(item.id)} />
      );
    case "user":
      return <UserBubble item={item} onRetry={onUserRetry ? () => onUserRetry(item.id) : undefined} />;
    case "assistant":
      return <AssistantBlock item={item} />;
    case "reasoning":
      return <ReasoningRow item={item} />;
    case "tool":
      return <ToolCard item={item} onPress={onToolPress ? () => onToolPress(item.id) : undefined} />;
    case "error":
      return <ErrorRow item={item} onRetry={onErrorRetry} />;
  }
});

function statusFor(
  run: ChatSnapshot["run"],
  connection: ConnectionPhase,
): { label: string; tone: "run" | "wait" | "danger" } {
  if (connection === "auth_failed") return { label: "Sign-in needed", tone: "danger" };
  if (connection === "offline") return { label: "Offline", tone: "danger" };
  if (connection === "reconnecting") return { label: "Reconnecting…", tone: "wait" };
  if (connection === "reconciling") return { label: "Catching up…", tone: "wait" };
  if (run === "running") return { label: "Running", tone: "run" };
  if (run === "aborting") return { label: "Stopping…", tone: "wait" };
  if (run === "awaiting_approval") return { label: "Waiting for you", tone: "wait" };
  return { label: "Connected", tone: "run" };
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{ conversationId: string; agentId: string; agentName?: string; title?: string; autosend?: string }>();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { activeProfile, refresh: refreshProfiles } = useProfiles();

  const sessionRef = useRef<ChatSession | null>(null);
  const listRef = useRef<FlatList<TranscriptRowItem>>(null);
  const [snapshot, setSnapshot] = useState<ChatSnapshot>({ ...emptyChat, hydrating: true });
  const [draft, setDraft] = useState("");
  // The nav param is only the title as it was when this screen was opened; a
  // rename (here or elsewhere) makes the server's value the truth.
  const [serverTitle, setServerTitle] = useState<string | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  // Collapsed tool runs the reader has opened (see lib/letta/grouping).
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attach = useCallback(async () => {
    haptic.tap();
    const picked = await pickImages();
    if (picked.length > 0) setAttachments((current) => [...current, ...picked].slice(0, 4));
  }, []);
  const nearBottomRef = useRef(true);
  // Inverted list: the newest content lives at offset 0.
  const pinToLatest = useCallback(() => {
    nearBottomRef.current = true;
    setNearBottom(true);
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  }, []);

  // Dev-only: fire one real send after hydration, so live e2e flows can be
  // driven headlessly (deep link ?autosend=...). No-op in production builds.
  const autosentRef = useRef(false);
  useEffect(() => {
    if (!__DEV__ || !params.autosend || autosentRef.current) return;
    if (snapshot.hydrating || !sessionRef.current) return;
    autosentRef.current = true;
    const text = params.autosend;
    const timer = setTimeout(() => {
      haptic.send();
      sessionRef.current?.send(text).catch(() => {
        // Dev-only path; the transcript's error row already reports failures.
      });
    }, 1200);
    return () => clearTimeout(timer);
  }, [params.autosend, snapshot.hydrating]);

  // Foreground resume: refetch authoritative state when the app returns, but
  // only after a real absence — a glance at a notification shouldn't cost a
  // full rehydrate and a banner flash.
  const backgroundedAt = useRef<number | null>(null);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        const away = backgroundedAt.current ? Date.now() - backgroundedAt.current : Infinity;
        backgroundedAt.current = null;
        if (away > 30_000) void sessionRef.current?.reconnect();
        return;
      }
      backgroundedAt.current ??= Date.now();
    });
    return () => sub.remove();
  }, []);

  // Drafts survive navigation and app restarts (per-conversation key).
  const draftKey = `letta.draft.${params.conversationId}`;
  // Mirrors `draft` so teardown can flush the newest value without making the
  // debounce effect depend on every keystroke.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  // A restore that lands after the user starts typing must not clobber them.
  const draftTouched = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(draftKey).then((saved) => {
      if (!cancelled && saved && !draftTouched.current) setDraft(saved);
    });
    return () => {
      cancelled = true;
    };
  }, [draftKey]);
  useEffect(() => {
    const timer = setTimeout(() => {
      void AsyncStorage.setItem(draftKey, draftRef.current);
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, draftKey]);
  // Unmount can beat the debounce; persist the last keystrokes synchronously.
  useEffect(
    () => () => {
      void AsyncStorage.setItem(draftKey, draftRef.current);
    },
    [draftKey],
  );
  const clearDraft = useCallback(() => {
    draftTouched.current = false;
    setDraft("");
    void AsyncStorage.removeItem(draftKey);
  }, [draftKey]);
  const editDraft = useCallback((next: string) => {
    draftTouched.current = true;
    setDraft(next);
  }, []);

  // Conversation-scoped model + reasoning controls.
  const modelSheetRef = useRef<BottomSheetModal>(null);
  const envSheetRef = useRef<BottomSheetModal>(null);
  const [computers, setComputers] = useState<ComputerSummary[]>([]);
  const [envLoading, setEnvLoading] = useState(false);
  const [envError, setEnvError] = useState<string | null>(null);
  const queueSheetRef = useRef<BottomSheetModal>(null);
  const controlsSheetRef = useRef<BottomSheetModal>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [approvalSubmitting, setApprovalSubmitting] = useState<"allow" | "deny" | undefined>();

  // Tool detail sheet: track the id, not the item — the open sheet keeps
  // receiving live status/result updates from the snapshot.
  const toolSheetRef = useRef<BottomSheetModal>(null);
  const [detailToolId, setDetailToolId] = useState<string | null>(null);
  const detailTool = useMemo(
    () =>
      (snapshot.transcript.find((t): t is ToolItem => t.kind === "tool" && t.id === detailToolId) ?? null),
    [snapshot.transcript, detailToolId],
  );
  const onToolPress = useCallback((id: string) => {
    setDetailToolId(id);
    toolSheetRef.current?.present();
  }, []);

  // The submitting label clears only when the session settles the decision —
  // confirmation, timeout, or stream failure (never same-render).
  const submitApproval = useCallback(
    (requestId: string, decision: "allow" | "deny", reason?: string, suggestionId?: string) => {
      const session = sessionRef.current;
      if (!session) return;
      setApprovalSubmitting(decision);
      void session
        .resolveApproval(requestId, decision, reason, suggestionId)
        .finally(() => setApprovalSubmitting(undefined));
    },
    [],
  );

  // Session lifecycle — one ChatSession per open conversation.
  useEffect(() => {
    if (!activeProfile || !params.conversationId) return;
    let cancelled = false;
    let opened: ChatSession | null = null;
    void (async () => {
      try {
        const secret = (await getSecret(activeProfile.id)) ?? "";
        const session = ChatSession.open({ profile: activeProfile, secret }, params.conversationId);
        if (cancelled) {
          session.close();
          return;
        }
        opened = session;
        sessionRef.current = session;
        // Scrolling belongs to the list's onContentSizeChange, not here: a
        // snapshot-time scroll races layout, since the hydration batch measures
        // after the scroll fires.
        session.subscribe(setSnapshot);
      } catch (error) {
        if (!cancelled) {
          setSnapshot({
            ...emptyChat,
            hydrating: false,
            connection: isAuthError(error) ? "auth_failed" : "offline",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
      opened?.close();
      sessionRef.current = null;
    };
  }, [activeProfile, params.conversationId]);

  // Load the current conversation model once hydration settles — on remote,
  // concurrent control-channel connections collide (single-slot app-server).
  useEffect(() => {
    if (!activeProfile || !params.conversationId || snapshot.hydrating) return;
    // Remote reads go through the session's own connection (the app-server
    // accepts one control client); wait briefly for the session ref, which is
    // set by the sibling effect. Cloud reads are plain REST.
    const timer = setTimeout(async () => {
      try {
        let current: { model: string | null; reasoningEffort: string | null; title: string | null };
        if (activeProfile.type === "remote") {
          for (let attempt = 0; !sessionRef.current && attempt < 20; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          if (!sessionRef.current) return;
          current = await sessionRef.current.getModelInfo();
        } else {
          current = await getConversationModel(
            { profile: activeProfile, secret: (await getSecret(activeProfile.id)) ?? "" },
            params.conversationId,
          );
        }
        setModel(current.model);
        setEffort(current.reasoningEffort);
        if (current.title) setServerTitle(current.title);
      } catch {
        // Chip falls back to "model" affordance; sheet still works.
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [activeProfile, params.conversationId, snapshot.hydrating]);

  const openModelSheet = useCallback(async () => {
    if (!activeProfile) return;
    setModelError(null);
    modelSheetRef.current?.present();
    if (models.length === 0) {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      try {
        setModels(await listModels({ profile: activeProfile, secret }));
      } catch {
        setModelError("Couldn't load models.");
      }
    }
  }, [activeProfile, models.length]);

  const selectModel = useCallback(
    async (handle: string, nextEffort?: ReasoningEffort) => {
      if (!activeProfile || !params.conversationId) return;
      modelSheetRef.current?.dismiss();
      const previous = { model, effort };
      setModel(handle);
      if (nextEffort) setEffort(nextEffort);
      setModelSaving(true);
      try {
        if (activeProfile.type === "remote" && sessionRef.current) {
          await sessionRef.current.setModel(handle, nextEffort);
        } else {
          const secret = (await getSecret(activeProfile.id)) ?? "";
          await updateConversationModel({ profile: activeProfile, secret }, params.conversationId, {
            model: handle,
            ...(nextEffort ? { reasoningEffort: nextEffort } : {}),
          });
        }
      } catch (e) {
        setModel(previous.model);
        setEffort(previous.effort);
        setModelError(e instanceof Error ? e.message : "Couldn't change the model.");
        modelSheetRef.current?.present();
      } finally {
        setModelSaving(false);
      }
    },
    [activeProfile, params.conversationId, model, effort],
  );

  // ── Environment selector (cloud profiles only) ──────────────────────────
  const openEnvSheet = useCallback(async () => {
    if (!activeProfile) return;
    setEnvError(null);
    envSheetRef.current?.present();
    if (computers.length === 0 && activeProfile.type === "cloud") {
      setEnvLoading(true);
      try {
        const secret = (await getSecret(activeProfile.id)) ?? "";
        setComputers(await listComputers({ profile: activeProfile, secret }));
      } catch {
        setEnvError("Couldn't load environments.");
      } finally {
        setEnvLoading(false);
      }
    }
  }, [activeProfile, computers.length]);

  const selectEnvironment = useCallback(
    async (connectionId: string | null, name: string | null) => {
      if (!activeProfile) return;
      const secret = await getSecret(activeProfile.id);
      const updated: typeof activeProfile = {
        ...activeProfile,
        computerSelector: connectionId ? { connectionId, name: name ?? undefined } : undefined,
      };
      await saveProfile(updated, secret);
      // Refresh the in-memory profile context so the chip and session
      // routing pick up the new computerSelector immediately.
      await refreshProfiles();
      // Force a new session on next send so the computer option takes effect.
      if (sessionRef.current) {
        sessionRef.current.close();
        sessionRef.current = null;
      }
    },
    [activeProfile, refreshProfiles],
  );

  // Display label for the environment chip — the name is stored in the
  // profile's computerSelector alongside the connectionId.
  const envChipLabel = activeProfile?.computerSelector
    ? typeof activeProfile.computerSelector === "string"
      ? activeProfile.computerSelector
      : "name" in activeProfile.computerSelector && activeProfile.computerSelector.name
        ? activeProfile.computerSelector.name
        : "connectionId" in activeProfile.computerSelector
          ? activeProfile.computerSelector.connectionId.slice(0, 8)
          : "env"
    : null;

  const running = snapshot.run === "running" || snapshot.run === "awaiting_approval";
  const aborting = snapshot.run === "aborting";

  // Send ↔ stop morph.
  const morph = useSharedValue(0);
  useEffect(() => {
    morph.set(withSpring(running || aborting ? 1 : 0, motion.move));
  }, [running, aborting, morph]);
  const morphStyle = useAnimatedStyle(() => ({
    borderRadius: 17 - morph.get() * 9,
  }));

  const onPrimaryAction = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    if (running) {
      haptic.stop();
      await session.abort();
      return;
    }
    const text = draft.trim();
    if (!text && attachments.length === 0) return;
    haptic.send();
    const images = attachments;
    setAttachments([]);
    clearDraft();
    // Sending always re-enters follow mode — your own message must be visible.
    pinToLatest();
    await session.send(text, images);
  }, [running, draft, attachments, pinToLatest, clearDraft]);

  const sendWhileRunning = useCallback(async () => {
    const session = sessionRef.current;
    const text = draft.trim();
    if (!session || (!text && attachments.length === 0)) return;
    haptic.queue();
    const images = attachments;
    setAttachments([]);
    clearDraft();
    pinToLatest();
    await session.send(text, images);
  }, [draft, attachments, pinToLatest, clearDraft]);

  const canSend = draft.trim().length > 0 || attachments.length > 0;
  const agentName = params.agentName ?? "Agent";
  const title = serverTitle ?? params.title ?? "Conversation";

  // Inverted-list data (references do chat this way — e.g. paseo's native
  // strategy): the visual bottom is offset 0, so new content pins natively
  // and keyboard/layout changes can't break "near bottom" tracking.
  const listData = useMemo(
    () => groupToolRuns(snapshot.transcript, expandedGroups).reverse(),
    [snapshot.transcript, expandedGroups],
  );
  const onToggleGroup = useCallback((id: string) => {
    haptic.tap();
    setExpandedGroups((open) => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const onUserRetry = useCallback(
    (id: string) => {
      haptic.send();
      void sessionRef.current?.retrySend(id);
      pinToLatest();
    },
    [pinToLatest],
  );
  const onErrorRetry = useCallback(() => {
    haptic.tap();
    void sessionRef.current?.reconnect();
  }, []);

  // Stable renderItem keeps TranscriptRow's memo effective across flushes.
  const renderItem = useCallback(
    ({ item }: { item: TranscriptRowItem }) => (
      <TranscriptRow
        item={item}
        onUserRetry={onUserRetry}
        onToolPress={onToolPress}
        onErrorRetry={onErrorRetry}
        onToggleGroup={onToggleGroup}
      />
    ),
    [onUserRetry, onToolPress, onErrorRetry, onToggleGroup],
  );

  // Between send-accepted and the first streamed token there is no transcript
  // activity — show a breathing "Thinking…" row so the turn never looks dead.
  const lastItem = snapshot.transcript[snapshot.transcript.length - 1];
  const streamingNow =
    (lastItem?.kind === "assistant" || lastItem?.kind === "reasoning") && lastItem.streaming;
  const toolActive = lastItem?.kind === "tool" && (lastItem.status === "running" || lastItem.status === "pending");
  const waitingForModel = running && !streamingNow && !toolActive;

  // Transient link states read as "working", not "broken" — only a genuine
  // loss of connectivity or bad credentials earns the danger tone.
  const status = statusFor(snapshot.run, snapshot.connection);

  return (
    <Screen>
      <Header
        title={title}
        back
        subtitle={
          <View style={styles.statusRow}>
            <Text role="sub" ink={2}>
              {agentName} · {status.label}
            </Text>
            <StatusDot tone={status.tone} />
          </View>
        }
      />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <View style={styles.flex}>
          {snapshot.hydrating ? (
            <SkeletonList rows={4} avatar={false} />
          ) : (
            <FlatList
            ref={listRef}
            data={listData}
            inverted
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.transcript}
            // Virtualization tuned like paseo's native strategy: enough rows
            // up front that a fast scroll into history doesn't blank, and a
            // wide window so streaming flushes never evict nearby cells.
            initialNumToRender={30}
            maxToRenderPerBatch={30}
            windowSize={21}
            // Inverted list: offset 0 IS the newest content, so being at the
            // bottom survives keyboard/layout changes, and pinning while
            // streaming is native. A reader who scrolled up keeps their place
            // (maintainVisibleContentPosition); Android ignores it under the
            // inversion transform, so iOS-only — same trade the references make.
            maintainVisibleContentPosition={
              Platform.OS === "ios" ? { minIndexForVisible: 0, autoscrollToTopThreshold: 40 } : undefined
            }
            // maintainVisibleContentPosition keeps a scrolled-up reader in place
            // but does not guarantee the live edge stays pinned once a hydration
            // batch measures, so re-pin explicitly for a reader who is following.
            onContentSizeChange={() => {
              if (nearBottomRef.current) listRef.current?.scrollToOffset({ offset: 0, animated: false });
            }}
            // Visual bottom, above the composer — shows while the model has
            // accepted the send but nothing has streamed back yet.
            ListHeaderComponent={waitingForModel ? <ThinkingRow /> : null}
            // Inverted list: the "end" is the visual top, so this is where
            // reaching the oldest loaded row asks for the previous page.
            onEndReached={() => void sessionRef.current?.loadOlder()}
            onEndReachedThreshold={0.2}
            ListFooterComponent={
              snapshot.loadingOlder ? (
                <View style={styles.olderSpinner}>
                  <ActivityIndicator size="small" color={colors.ink3} />
                </View>
              ) : null
            }
            ListEmptyComponent={
              <View style={styles.invertedEmpty}>
                <EmptyState message={`No messages yet. Say hello to ${agentName}.`} />
              </View>
            }
            // Dragging the transcript pulls the keyboard down with the gesture.
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onScroll={(e) => {
              const offset = e.nativeEvent.contentOffset.y;
              nearBottomRef.current = offset < 80;
              setNearBottom(offset < 80);
            }}
              scrollEventThrottle={16}
            />
          )}
          {/* Anchored to the list's own bottom edge, so it clears the composer
              at any height and never lands on the transcript's newest row. */}
          {!nearBottom ? (
            <Animated.View
              entering={FadeIn.duration(motion.micro.duration)}
              exiting={FadeOut.duration(motion.micro.duration)}
              style={styles.latestWrap}
              pointerEvents="box-none"
            >
              <Touchable
                accessibilityRole="button"
                accessibilityLabel="Jump to latest"
                onPress={pinToLatest}
                style={[styles.latest, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}
              >
                <Text role="sub" ink={2}>
                  ↓ Latest
                </Text>
              </Touchable>
            </Animated.View>
          ) : null}
        </View>

        <View
          style={[
            styles.composerWrap,
            { borderColor: colors.surfaceEdge, paddingBottom: Math.max(insets.bottom, space.md) },
          ]}
        >
          {snapshot.connection !== "connected" ? (
            <ConnectionBanner
              phase={snapshot.connection}
              target={activeProfile?.name}
              onRetry={() => void sessionRef.current?.reconnect()}
              onEditProfile={() => router.push("/profile")}
            />
          ) : null}
          <QueueCapsule queue={snapshot.queue} onPress={() => queueSheetRef.current?.present()} />
          {snapshot.approvals[0] ? (
            <ApprovalCard
              request={snapshot.approvals[0]}
              position={
                snapshot.approvals.length > 1 ? { index: 1, total: snapshot.approvals.length } : undefined
              }
              cwd={snapshot.device?.workingDirectory}
              submitting={approvalSubmitting}
              onAllow={(reason) => submitApproval(snapshot.approvals[0]!.requestId, "allow", reason)}
              onDeny={(reason) => submitApproval(snapshot.approvals[0]!.requestId, "deny", reason)}
              onAcceptSuggestion={(suggestionId) =>
                submitApproval(snapshot.approvals[0]!.requestId, "allow", undefined, suggestionId)
              }
            />
          ) : null}
          {attachments.length > 0 && snapshot.approvals.length === 0 ? (
            <View style={styles.attachRow}>
              {attachments.map((a) => (
                <Touchable
                  key={a.id}
                  accessibilityRole="button"
                  accessibilityLabel="Remove attachment"
                  onPress={() => setAttachments((current) => current.filter((c) => c.id !== a.id))}
                  style={styles.attachChip}
                >
                  <Image source={{ uri: a.uri }} style={styles.attachThumb} contentFit="cover" />
                  <View style={[styles.attachRemove, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge }]}>
                    <Text role="micro" ink={2}>
                      ✕
                    </Text>
                  </View>
                </Touchable>
              ))}
            </View>
          ) : null}
          <View
            style={[
              styles.composer,
              { backgroundColor: colors.surface, borderColor: colors.surfaceEdge },
              snapshot.approvals.length > 0 && styles.hidden,
            ]}
          >
            <Touchable
              accessibilityRole="button"
              accessibilityLabel="Attach images"
              onPress={() => void attach()}
              disabled={snapshot.hydrating || attachments.length >= 4}
              style={styles.attachButton}
            >
              <Text role="title" ink={attachments.length >= 4 ? 3 : 2}>
                ＋
              </Text>
            </Touchable>
            <TextInput
              value={draft}
              onChangeText={editDraft}
              placeholder={running ? "Add a follow-up…" : `Message ${agentName}…`}
              placeholderTextColor={colors.ink3}
              // Past the growth cap the field scrolls instead of freezing the
              // caret out of view — long pastes stay navigable.
              style={[styles.input, { color: colors.ink }]}
              multiline
              scrollEnabled
              editable={!snapshot.hydrating}
            />
          </View>
          <View style={styles.chipRow}>
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={`Model ${model ?? "default"}${effort ? `, effort ${effort}` : ""}. Change model`}
              onPress={openModelSheet}
              style={styles.modelChip}
            >
              <Text role="sub" ink={2} mono numberOfLines={1}>
                {modelSaving ? "Saving…" : model ? model.split("/").pop() : "model"}
                {!modelSaving && effort ? ` · ${effort}` : ""}
              </Text>
            </Touchable>
            {activeProfile?.type === "cloud" ? (
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={`Environment: ${envChipLabel ?? "Cloud Sandbox"}. Change environment`}
                onPress={openEnvSheet}
                style={styles.modelChip}
              >
                <Text role="sub" ink={2} mono numberOfLines={1}>
                  {envChipLabel ?? "cloud"}
                </Text>
              </Touchable>
            ) : null}
            {snapshot.device ? (
              <Touchable
                accessibilityRole="button"
                accessibilityLabel={`Permission mode: ${snapshot.device.permissionMode}. Change controls`}
                onPress={() => controlsSheetRef.current?.present()}
                style={styles.modelChip}
              >
                <Text role="sub" ink={2}>
                  {snapshot.device.permissionMode === "acceptEdits"
                    ? "Accept edits"
                    : snapshot.device.permissionMode === "unrestricted"
                      ? "Unrestricted"
                      : "Standard"}
                </Text>
              </Touchable>
            ) : null}
            <View style={styles.spacer} />
            {running && canSend ? (
              <Touchable accessibilityRole="button" accessibilityLabel="Queue follow-up" onPress={sendWhileRunning} style={styles.queueSend}>
                <Text role="sub" tone="accent">
                  Queue
                </Text>
              </Touchable>
            ) : null}
            <Touchable
              accessibilityRole="button"
              accessibilityLabel={running ? "Stop" : "Send"}
              disabled={aborting || (!running && !canSend)}
              onPress={onPrimaryAction}
              style={styles.sendTouch}
            >
              <Animated.View
                style={[
                  styles.send,
                  morphStyle,
                  { backgroundColor: running || aborting ? colors.danger : colors.accent, opacity: !running && !canSend ? 0.4 : 1 },
                ]}
              >
                {running || aborting ? (
                  <View style={styles.stopGlyph} />
                ) : (
                  <Text role="bodyEm" style={styles.sendGlyph}>
                    ↑
                  </Text>
                )}
              </Animated.View>
            </Touchable>
          </View>
        </View>
      </KeyboardAvoidingView>
      <QueueSheet
        ref={queueSheetRef}
        queue={snapshot.queue}
        onRemove={(id) => void sessionRef.current?.removeQueueItem(id)}
        onEditResend={(item) => {
          void sessionRef.current?.removeQueueItem(item.id);
          // Never destroy work in progress: append behind whatever is typed.
          editDraft(draftRef.current.trim() ? `${draftRef.current.trimEnd()}\n${item.text}` : item.text);
          queueSheetRef.current?.dismiss();
        }}
      />
      <Sheet ref={controlsSheetRef} title="Permission mode">
        {(
          [
            { mode: "strict" as PermissionMode, label: "Strict", detail: "Every tool asks, even reads" },
            { mode: "standard" as PermissionMode, label: "Standard", detail: "Asks before risky tools" },
            { mode: "acceptEdits" as PermissionMode, label: "Accept edits", detail: "File edits are auto-approved" },
            { mode: "unrestricted" as PermissionMode, label: "Unrestricted", detail: "Everything auto-approved" },
          ]
        ).map(({ mode, label, detail }) => {
          const selected = snapshot.device?.permissionMode === mode;
          return (
            <Touchable
              key={mode}
              accessibilityRole="button"
              accessibilityLabel={`${label}. ${detail}${selected ? ". Selected" : ""}`}
              onPress={() => {
                void sessionRef.current?.setPermissionMode(mode);
                controlsSheetRef.current?.dismiss();
              }}
              style={styles.permissionRow}
            >
              <View style={styles.permissionRowInner}>
                <View style={styles.permissionText}>
                  <Text role="body" tone={mode === "unrestricted" ? "danger" : undefined}>
                    {label}
                  </Text>
                  <Text role="sub" ink={3}>
                    {detail}
                  </Text>
                </View>
                {selected ? (
                  <Text role="bodyEm" tone="accent">
                    ✓
                  </Text>
                ) : null}
              </View>
            </Touchable>
          );
        })}
        {snapshot.device?.workingDirectory ? (
          <Text role="sub" ink={3} mono numberOfLines={1}>
            cwd: {snapshot.device.workingDirectory}
          </Text>
        ) : null}
        {snapshot.device?.memoryDirectory ? (
          <Text role="sub" ink={3} mono numberOfLines={1}>
            memory: {snapshot.device.memoryDirectory}
          </Text>
        ) : null}
      </Sheet>
      <ToolDetailSheet ref={toolSheetRef} tool={detailTool} />
      <ModelSheet
        ref={modelSheetRef}
        models={models}
        currentModel={model}
        currentEffort={effort}
        onSelect={(handle, nextEffort) => void selectModel(handle, nextEffort)}
        error={modelError}
      />
      {activeProfile?.type === "cloud" ? (
        <EnvironmentSheet
          ref={envSheetRef}
          computers={computers}
          selectedConnectionId={
            activeProfile?.computerSelector && typeof activeProfile.computerSelector === "object" && "connectionId" in activeProfile.computerSelector
              ? activeProfile.computerSelector.connectionId
              : null
          }
          onSelect={(connectionId, name) => {
            void selectEnvironment(connectionId, name);
          }}
          loading={envLoading}
          error={envError}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  // Inverted list: style paddingTop renders at the VISUAL bottom (above the
  // composer), paddingBottom at the visual top.
  transcript: { paddingHorizontal: space.gutter, paddingTop: space.xl, paddingBottom: space.md, gap: space.md },
  // FlatList does not counter-rotate ListEmptyComponent when `inverted` is set.
  invertedEmpty: { transform: [{ scaleY: -1 }] },
  latestWrap: { position: "absolute", left: 0, right: 0, bottom: space.md, alignItems: "center" },
  olderSpinner: { paddingVertical: space.md, alignItems: "center" },
  attachRow: { flexDirection: "row", gap: space.sm, paddingBottom: space.sm },
  attachChip: { width: 64, height: 64 },
  attachThumb: { width: 64, height: 64, borderRadius: radius.row },
  attachRemove: {
    position: "absolute",
    top: -4,
    right: -4,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  attachButton: { paddingRight: space.sm, minHeight: 32, justifyContent: "center" },
  latest: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.chip,
    paddingHorizontal: space.md,
    minHeight: 32,
  },
  composerWrap: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.gutter,
    paddingTop: space.md,
    gap: space.sm,
  },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    borderRadius: radius.bubble,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
    paddingVertical: 10,
  },
  // ~7 lines before it scrolls: references cap growth near a third of the
  // screen so the transcript never disappears behind the composer.
  input: { flex: 1, fontSize: 16, lineHeight: 21, maxHeight: 168, padding: 0 },
  chipRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  hidden: { display: "none" },
  spacer: { flex: 1 },
  queueSend: { paddingHorizontal: space.sm },
  modelChip: { maxWidth: 220, paddingVertical: 4 },
  permissionRow: { minHeight: 52 },
  permissionRowInner: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6 },
  permissionText: { flex: 1, gap: 1 },
  sendTouch: { minHeight: 34 },
  send: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  sendGlyph: { color: "#FFFFFF" },
  stopGlyph: { width: 12, height: 12, borderRadius: 2, backgroundColor: "#FFFFFF" },
});
