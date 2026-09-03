/**
 * Conversations for one agent — live list with create, rename, and cursor
 * pagination (docs/design-doc.md §4.3). Cloud lists via REST, remote via
 * protocol `conversation_list`.
 */
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, FlatList, RefreshControl, StyleSheet, TextInput, View } from "react-native";

import { EmptyState } from "../components/ui/EmptyState";
import { Header, Screen } from "../components/ui/Screen";
import { Sheet } from "../components/ui/Sheet";
import { SkeletonList } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { Text } from "../components/ui/Text";
import { Touchable } from "../components/ui/Touchable";
import {
  canDeleteConversations,
  createConversation,
  deleteConversation,
  listConversations,
  renameConversation,
  type ConversationSummary,
} from "../lib/letta/api";
import {
  conversationActivity,
  subscribeConversationActivity,
  type ConversationActivity,
} from "../lib/letta/ChatSession";
import { setStringAsync as copyToClipboard } from "expo-clipboard";
import { getSecret } from "../lib/profiles/profiles";
import { useProfiles } from "../lib/profiles/ProfilesContext";
import { useTheme } from "../theme/ThemeProvider";
import { radius, space } from "../theme/tokens";

const PAGE_SIZE = 30;

function relativeTime(iso?: string): string {
  if (!iso) return "no messages yet";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/** Live state for conversations open on this device; null when idle. */
function useActivity(conversationId: string): ConversationActivity | null {
  const read = useCallback(() => conversationActivity(conversationId), [conversationId]);
  return useSyncExternalStore(subscribeConversationActivity, read);
}

function ConversationRow({ conversation, onPress, onLongPress }: {
  conversation: ConversationSummary;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const { colors } = useTheme();
  const activity = useActivity(conversation.id);
  const activityLabel =
    activity === "awaiting_approval" ? "needs approval" : activity === "running" ? "running" : null;
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${conversation.title}. ${
        activityLabel ? `${activityLabel}. ` : ""
      }${relativeTime(conversation.lastMessageAt)}`}
      onPress={onPress}
      onLongPress={onLongPress}
      scaleOnPress={false}
      style={styles.row}
    >
      <View style={styles.rowInner}>
        <View style={styles.rowText}>
          <Text role="bodyEm" numberOfLines={1}>
            {conversation.title}
          </Text>
          <Text role="sub" ink={3}>
            {activityLabel ?? relativeTime(conversation.lastMessageAt)}
          </Text>
        </View>
        {activity ? (
          <StatusDot tone={activity === "awaiting_approval" ? "wait" : "run"} />
        ) : null}
      </View>
      <View style={[styles.divider, { backgroundColor: colors.surfaceEdge }]} />
    </Touchable>
  );
}

export default function ConversationsScreen() {
  const params = useLocalSearchParams<{ agentId: string; agentName?: string }>();
  const agentId = params.agentId;
  const agentName = params.agentName ?? "Agent";
  const { colors } = useTheme();
  const { activeProfile } = useProfiles();

  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const actionsSheetRef = useRef<BottomSheetModal>(null);
  const [actionTarget, setActionTarget] = useState<ConversationSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [search, setSearch] = useState("");
  const renameSheetRef = useRef<BottomSheetModal>(null);
  const [renaming, setRenaming] = useState<ConversationSummary | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  const load = useCallback(async () => {
    if (!activeProfile || !agentId) return;
    setError(null);
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      const page = await listConversations({ profile: activeProfile, secret }, agentId, { limit: PAGE_SIZE });
      loadedAt.current = Date.now();
      setConversations(page);
      setHasMore(page.length === PAGE_SIZE);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load conversations.");
      setConversations((prev) => prev ?? []);
    }
  }, [activeProfile, agentId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  // Coming back from a chat, the list is stale: titles get auto-summarized and
  // a new conversation may exist. Refetch on focus, but not on every quick
  // flip back and forth.
  // load() stamps this; 0 means "never loaded", so the first focus refetches.
  const loadedAt = useRef(0);
  const refreshIfStale = useCallback(() => {
    if (Date.now() - loadedAt.current < 10_000) return;
    void load();
  }, [load]);
  useFocusEffect(refreshIfStale);

  const loadMore = async () => {
    if (!activeProfile || !conversations?.length || loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      const page = await listConversations({ profile: activeProfile, secret }, agentId, {
        limit: PAGE_SIZE,
        before: conversations[conversations.length - 1]!.id,
      });
      setConversations([...conversations, ...page]);
      setHasMore(page.length === PAGE_SIZE);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  };

  const openChat = (conversation: ConversationSummary) => {
    router.push({
      pathname: "/chat",
      params: { conversationId: conversation.id, agentId, agentName, title: conversation.title },
    });
  };

  const startNew = async () => {
    if (!activeProfile) return;
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      const id = await createConversation({ profile: activeProfile, secret }, agentId);
      router.push({ pathname: "/chat", params: { conversationId: id, agentId, agentName, title: "New conversation" } });
    } catch (e) {
      Alert.alert("Couldn't start a conversation", e instanceof Error ? e.message : undefined);
    }
  };

  // Alert.prompt is iOS-only, so renaming rides the app's own sheet + input.
  const openRename = (conversation: ConversationSummary) => {
    setRenaming(conversation);
    setDraftTitle(conversation.title);
    renameSheetRef.current?.present();
  };

  const submitRename = async () => {
    const title = draftTitle.trim();
    if (!activeProfile || !renaming || !title) return;
    renameSheetRef.current?.dismiss();
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      await renameConversation({ profile: activeProfile, secret }, renaming.id, title);
      await load();
    } catch (e) {
      Alert.alert("Couldn't rename", e instanceof Error ? e.message : undefined);
    }
  };

  const confirmDelete = (conversation: ConversationSummary) => {
    Alert.alert(`Delete “${conversation.title}”?`, "The conversation and its history are removed.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          if (!activeProfile) return;
          const secret = (await getSecret(activeProfile.id)) ?? "";
          // Optimistic: the row leaves immediately, restored if the call fails.
          const previous = conversations;
          setConversations((rows) => (rows ?? []).filter((c) => c.id !== conversation.id));
          try {
            await deleteConversation({ profile: activeProfile, secret }, conversation.id);
          } catch (e) {
            setConversations(previous);
            Alert.alert("Couldn't delete", e instanceof Error ? e.message : undefined);
          }
        },
      },
    ]);
  };

  const showActions = (conversation: ConversationSummary) => {
    setActionTarget(conversation);
    actionsSheetRef.current?.present();
  };

  const filtered = (conversations ?? []).filter((c) =>
    c.title.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return (
    <Screen>
      <Header
        title={agentName}
        large
        back
        subtitle={
          <Text role="sub" ink={2}>
            {conversations ? `${conversations.length}${hasMore ? "+" : ""} conversations` : "Conversations"}
          </Text>
        }
        trailing={
          <Touchable accessibilityLabel="New conversation" accessibilityRole="button" onPress={startNew} style={styles.add}>
            <Text role="title" tone="accent">
              ＋
            </Text>
          </Touchable>
        }
      />
      {conversations !== null && conversations.length > 0 ? (
        <View style={styles.searchWrap}>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search conversations…"
            placeholderTextColor={colors.ink3}
            autoCapitalize="none"
            style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge, color: colors.ink }]}
          />
        </View>
      ) : null}
      {conversations === null ? (
        <SkeletonList rows={6} avatar={false} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => (
            <ConversationRow
              conversation={item}
              onPress={() => openChat(item)}
              onLongPress={() => showActions(item)}
            />
          )}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
              tintColor={colors.ink3}
            />
          }
          contentContainerStyle={styles.list}
          ListFooterComponent={
            loadingMore ? (
              <Text role="sub" ink={3} style={styles.footer}>
                Loading more…
              </Text>
            ) : (
              <Text role="sub" ink={3} style={styles.footer}>
                Long-press a conversation for actions.
              </Text>
            )
          }
          ListEmptyComponent={
            error ? (
              <EmptyState message={error} actionLabel="Retry" onAction={() => void load()} />
            ) : search.trim() ? (
              <EmptyState message={`No conversations match “${search.trim()}”.`} />
            ) : (
              <EmptyState message="No conversations yet." actionLabel="New conversation" onAction={startNew} />
            )
          }
        />
      )}
      <Sheet ref={renameSheetRef} title="Rename conversation">
        <TextInput
          value={draftTitle}
          onChangeText={setDraftTitle}
          placeholder="Conversation title"
          placeholderTextColor={colors.ink3}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={() => void submitRename()}
          style={[styles.sheetInput, { borderColor: colors.surfaceEdge, color: colors.ink }]}
        />
        <Touchable
          accessibilityRole="button"
          accessibilityLabel="Save title"
          onPress={() => void submitRename()}
          disabled={draftTitle.trim().length === 0}
          style={[
            styles.sheetAction,
            { backgroundColor: colors.accent, opacity: draftTitle.trim().length === 0 ? 0.4 : 1 },
          ]}
        >
          <Text role="bodyEm" style={styles.sheetActionLabel}>
            Save
          </Text>
        </Touchable>
      </Sheet>
      <Sheet
        ref={actionsSheetRef}
        title={actionTarget?.title ?? "Actions"}
        onSheetDismiss={() => setActionTarget(null)}
      >
        {actionTarget ? (
          (() => {
            const deletable = activeProfile
              ? canDeleteConversations({ profile: activeProfile, secret: "" })
              : false;
            return (
              <>
                <Touchable
                  accessibilityRole="button"
                  accessibilityLabel={`Copy conversation ID for ${actionTarget.title}`}
                  onPress={() => {
                    void copyToClipboard(actionTarget.id);
                    actionsSheetRef.current?.dismiss();
                  }}
                  style={styles.actionRow}
                >
                  <Text role="body">Copy conversation ID</Text>
                </Touchable>
                <Touchable
                  accessibilityRole="button"
                  accessibilityLabel={`Rename ${actionTarget.title}`}
                  onPress={() => {
                    actionsSheetRef.current?.dismiss();
                    openRename(actionTarget);
                  }}
                  style={styles.actionRow}
                >
                  <Text role="body">Rename</Text>
                </Touchable>
                {deletable ? (
                  <Touchable
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${actionTarget.title}`}
                    onPress={() => {
                      actionsSheetRef.current?.dismiss();
                      confirmDelete(actionTarget);
                    }}
                    style={styles.actionRow}
                  >
                    <Text role="body" tone="danger">
                      Delete
                    </Text>
                  </Touchable>
                ) : null}
              </>
            );
          })()
        ) : null}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actionRow: { paddingVertical: 14 },
  list: { paddingBottom: space.xxl, flexGrow: 1 },
  row: { paddingHorizontal: space.gutter },
  rowInner: { flexDirection: "row", alignItems: "center", paddingVertical: 14 },
  rowText: { flex: 1, gap: 2 },
  divider: { height: StyleSheet.hairlineWidth },
  add: { paddingHorizontal: space.sm },
  footer: { textAlign: "center", paddingVertical: space.md },
  searchWrap: { paddingHorizontal: space.gutter, paddingBottom: space.sm },
  search: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    fontSize: 15,
  },
  sheetInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: 11,
    fontSize: 16,
  },
  sheetAction: { minHeight: 46, borderRadius: radius.row, alignItems: "center", justifyContent: "center" },
  sheetActionLabel: { color: "#FFFFFF" },
});
