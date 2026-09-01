/**
 * Agents — live agent list for the active connection, with create and
 * rename/delete. Cloud lists via REST, remote via protocol `agent_list`;
 * creation goes through the Agent SDK client (docs/design-doc.md §4.2,
 * Appendix A).
 */
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, FlatList, RefreshControl, StyleSheet, TextInput, View } from "react-native";

import AsyncStorage from "@react-native-async-storage/async-storage";
import { Image } from "expo-image";
import { Bloop } from "../components/ui/Bloop";
import { EmptyState } from "../components/ui/EmptyState";
import { Header, Screen } from "../components/ui/Screen";
import { Sheet } from "../components/ui/Sheet";
import { SkeletonList } from "../components/ui/Skeleton";
import { StatusDot } from "../components/ui/StatusDot";
import { Text } from "../components/ui/Text";
import { Touchable } from "../components/ui/Touchable";
import { haptic } from "../lib/haptics";
import {
  createAgent,
  deleteAgent,
    fetchAgentProfilePicture,
listAgents,
  listModels,
  updateAgent,
  type AgentSummary,
  type ModelOption,
} from "../lib/letta/api";
import { getSecret, type Profile } from "../lib/profiles/profiles";
import { useProfiles } from "../lib/profiles/ProfilesContext";
import { useTheme } from "../theme/ThemeProvider";
import { radius, space } from "../theme/tokens";

function relativeTime(iso?: string): string {
  if (!iso) return "no activity yet";
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/** Strip the provider prefix for display: "anthropic/claude-x" → "claude-x". */
function shortModel(model: string): string {
  return model.includes("/") ? model.split("/").slice(1).join("/") : model;
}


const AVATAR_CACHE_PREFIX = "letta.avatar.";

/**
 * Cache-first: a stored avatar renders instantly, then a background request
 * validates the MemFS commit — the image is only re-downloaded when the
 * commit changed. Returns the cache hit immediately (null = nothing cached
 * and/or nothing on the server — callers fall back to the Bloop mark).
 */
async function loadAgentAvatar(
  conn: { profile: Profile; secret: string },
  agentId: string,
): Promise<string | null> {
  let cachedDataUrl: string | null = null;
  try {
    const cached = await AsyncStorage.getItem(AVATAR_CACHE_PREFIX + agentId);
    if (cached) {
      const parsed = JSON.parse(cached) as { dataUrl?: string };
      if (parsed.dataUrl) cachedDataUrl = parsed.dataUrl;
    }
  } catch {
    // Cache read failure is invisible — fall through to the network.
  }
  const fresh = await fetchAgentProfilePicture(conn, agentId);
  if (!fresh) return cachedDataUrl;
  if (cachedDataUrl) {
    try {
      const cached = await AsyncStorage.getItem(AVATAR_CACHE_PREFIX + agentId);
      const parsed = cached ? (JSON.parse(cached) as { commitSha?: string | null }) : null;
      if (parsed && parsed.commitSha === fresh.commitSha) return cachedDataUrl;
    } catch {
      // fall through — refresh the cache
    }
  }
  try {
    await AsyncStorage.setItem(AVATAR_CACHE_PREFIX + agentId, JSON.stringify(fresh));
  } catch {
    // Cache write failure is invisible too — the image still renders.
  }
  return fresh.dataUrl;
}

function AgentRow({ agent, avatarUrl, onPress, onLongPress }: { agent: AgentSummary; avatarUrl?: string; onPress: () => void; onLongPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${agent.name}, ${shortModel(agent.model)}, active ${relativeTime(agent.lastActive)}`}
      onPress={onPress}
      onLongPress={onLongPress}
      scaleOnPress={false}
      style={styles.row}
    >
      <View style={styles.rowInner}>
        {avatarUrl ? (
          <Image source={{ uri: avatarUrl }} style={styles.avatar} contentFit="cover" transition={150} />
        ) : (
          <Bloop id={agent.id} />
        )}
        <View style={styles.rowText}>
          <Text role="bodyEm" numberOfLines={1}>
            {agent.name}
          </Text>
          <View style={styles.meta}>
            <Text role="sub" ink={2} mono numberOfLines={1}>
              {shortModel(agent.model)}
            </Text>
            <Text role="sub" ink={3}>
              · {relativeTime(agent.lastActive)}
            </Text>
          </View>
        </View>
      </View>
      <View style={[styles.divider, { backgroundColor: colors.surfaceEdge }]} />
    </Touchable>
  );
}

export default function AgentsScreen() {
  const { colors } = useTheme();
  const { activeProfile } = useProfiles();
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");

  // Create/edit sheet state.
  const sheetRef = useRef<BottomSheetModal>(null);
  const [editing, setEditing] = useState<AgentSummary | null>(null);
  const [draftName, setDraftName] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [avatars, setAvatars] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!activeProfile) return;
    setError(null);
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      const list = await listAgents({ profile: activeProfile, secret });
      loadedAt.current = Date.now();
      setAgents(list);
      // Profile pictures load after the list renders — decoration, never a blocker.
      void (async () => {
        const entries = await Promise.all(
          list.map(async (agent) => [agent.id, await loadAgentAvatar({ profile: activeProfile, secret }, agent.id)] as const),
        );
        const next: Record<string, string> = {};
        for (const [id, url] of entries) {
          if (url) next[id] = url;
        }
        setAvatars(next);
      })();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load agents.");
      setAgents((prev) => prev ?? []);
    }
  }, [activeProfile]);

  useEffect(() => {
    // Defer past the synchronous effect body to satisfy the compiler's
    // cascading-render rule; load() sets state from network callbacks.
    const timer = setTimeout(() => {
      setAgents(null);
      void load();
    }, 0);
    return () => clearTimeout(timer);
  }, [load]);

  // Returning from a conversation, names and last-activity order are stale;
  // load() stamps loadedAt, so quick flips back don't refetch.
  const loadedAt = useRef(0);
  const refreshIfStale = useCallback(() => {
    if (Date.now() - loadedAt.current < 10_000) return;
    void load();
  }, [load]);
  useFocusEffect(refreshIfStale);

  const openCreate = async () => {
    if (!activeProfile) return;
    setEditing(null);
    setDraftName("");
    setDraftModel(null);
    sheetRef.current?.present();
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      setModels(await listModels({ profile: activeProfile, secret }));
    } catch {
      setModels([]);
    }
  };

  const openEdit = (agent: AgentSummary) => {
    setEditing(agent);
    setDraftName(agent.name);
    sheetRef.current?.present();
  };

  const submit = async () => {
    if (!activeProfile) return;
    setSaving(true);
    try {
      const secret = (await getSecret(activeProfile.id)) ?? "";
      const conn = { profile: activeProfile, secret };
      if (editing) {
        await updateAgent(conn, editing.id, { name: draftName.trim() });
      } else {
        if (!draftModel) return;
        await createAgent(conn, { name: draftName.trim() || "New agent", model: draftModel });
      }
      sheetRef.current?.dismiss();
      await load();
    } catch (e) {
      Alert.alert(editing ? "Couldn't rename agent" : "Couldn't create agent", e instanceof Error ? e.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (agent: AgentSummary) => {
    Alert.alert(`Delete ${agent.name}?`, "This deletes the agent and its conversations.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          if (!activeProfile) return;
          const secret = (await getSecret(activeProfile.id)) ?? "";
          try {
            await deleteAgent({ profile: activeProfile, secret }, agent.id);
            haptic.queue();
            await load();
          } catch (e) {
            Alert.alert("Couldn't delete agent", e instanceof Error ? e.message : undefined);
          }
        },
      },
    ]);
  };

  const showActions = (agent: AgentSummary) => {
    Alert.alert(agent.name, undefined, [
      { text: "Rename", onPress: () => openEdit(agent) },
      { text: "Delete", style: "destructive", onPress: () => confirmDelete(agent) },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const filtered = (agents ?? []).filter((a) => a.name.toLowerCase().includes(search.toLowerCase()));
  const canSubmit = editing ? draftName.trim().length > 0 : draftModel !== null;

  return (
    <Screen>
      <Header
        title="Agents"
        large
        back
        subtitle={
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={`Connection: ${activeProfile?.name ?? "none"}. Switch connection`}
            onPress={() => router.dismissTo("/")}
            style={styles.profileChipTouch}
          >
            <View style={styles.profileChip}>
              <StatusDot tone={activeProfile ? "run" : "idle"} />
              <Text role="sub" ink={2}>
                {activeProfile?.name ?? "No connection"}
              </Text>
            </View>
          </Touchable>
        }
        trailing={
          <Touchable accessibilityLabel="Create agent" accessibilityRole="button" onPress={openCreate} style={styles.add}>
            <Text role="title" tone="accent">
              ＋
            </Text>
          </Touchable>
        }
      />
      {agents !== null && agents.length > 0 ? (
        <View style={styles.searchWrap}>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search agents…"
            placeholderTextColor={colors.ink3}
            autoCapitalize="none"
            style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.surfaceEdge, color: colors.ink }]}
          />
        </View>
      ) : null}

      {agents === null ? (
        <SkeletonList rows={5} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(a) => a.id}
          renderItem={({ item }) => (
            <AgentRow
              agent={item}
              avatarUrl={avatars[item.id]}
              onPress={() => router.push({ pathname: "/conversations", params: { agentId: item.id, agentName: item.name } })}
              onLongPress={() => showActions(item)}
            />
          )}
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
          ListEmptyComponent={
            error ? (
              <EmptyState message={error} actionLabel="Retry" onAction={() => void load()} />
            ) : search ? (
              <EmptyState message={`No agents match “${search}”.`} />
            ) : (
              <EmptyState message="No agents yet. Create your first one." actionLabel="Create agent" onAction={openCreate} />
            )
          }
        />
      )}

      <Sheet ref={sheetRef} title={editing ? "Rename agent" : "New agent"}>
        <TextInput
          value={draftName}
          onChangeText={setDraftName}
          placeholder="Agent name"
          placeholderTextColor={colors.ink3}
          style={[styles.sheetInput, { borderColor: colors.surfaceEdge, color: colors.ink }]}
        />
        {!editing ? (
          <View style={styles.modelBlock}>
            <Text role="micro" ink={3}>
              Model
            </Text>
            {models.length === 0 ? (
              <Text role="sub" ink={3}>
                Loading models…
              </Text>
            ) : (
              models.slice(0, 6).map((m) => (
                <Touchable
                  key={m.handle}
                  accessibilityRole="button"
                  accessibilityLabel={`Model ${m.label}${draftModel === m.handle ? ", selected" : ""}`}
                  onPress={() => setDraftModel(m.handle)}
                  style={styles.modelRow}
                >
                  <View style={styles.modelRowInner}>
                    <Text role="body">{m.label}</Text>
                    <Text role="sub" ink={3} mono style={styles.modelHandle}>
                      {m.handle}
                    </Text>
                    {draftModel === m.handle ? (
                      <Text role="bodyEm" tone="accent">
                        ✓
                      </Text>
                    ) : null}
                  </View>
                </Touchable>
              ))
            )}
          </View>
        ) : null}
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={editing ? "Save name" : "Create agent"}
          disabled={!canSubmit || saving}
          onPress={submit}
          style={[styles.sheetAction, { backgroundColor: colors.accent, opacity: canSubmit && !saving ? 1 : 0.5 }]}
        >
          <Text role="bodyEm" style={styles.sheetActionLabel}>
            {saving ? "Working…" : editing ? "Save" : "Create agent"}
          </Text>
        </Touchable>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: { width: 44, height: 44, borderRadius: 999 },
  list: { paddingBottom: space.xxl, flexGrow: 1 },
  row: { paddingHorizontal: space.gutter },
  rowInner: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: 14 },
  rowText: { flex: 1, gap: 2 },
  meta: { flexDirection: "row", alignItems: "center", gap: space.xs },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 52 },
  profileChip: { flexDirection: "row", alignItems: "center", gap: 6 },
  profileChipTouch: { minHeight: 24, alignSelf: "flex-start" },
  add: { paddingHorizontal: space.sm },
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
    paddingVertical: 12,
    fontSize: 16,
  },
  modelBlock: { gap: space.sm },
  modelRow: { minHeight: 40 },
  modelRowInner: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 4 },
  modelHandle: { flex: 1 },
  sheetAction: { borderRadius: radius.row, alignItems: "center", marginTop: space.xs },
  sheetActionLabel: { color: "#FFFFFF", paddingVertical: 13 },
});
