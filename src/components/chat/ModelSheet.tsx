/**
 * Model & reasoning sheet (docs/design-doc.md §4.5): search, favorites +
 * recents, deduped model rows with mono handles, and an effort segment that
 * only offers the tiers the selected model's catalog actually ships. Saving
 * state stays on the chip until the server confirms; failures revert with an
 * inline error.
 */
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { forwardRef, useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";

import type { ModelOption, ReasoningEffort } from "../../lib/letta/api";
import {
  loadFavoriteModels,
  loadRecentModels,
  pushRecentModel,
  toggleFavoriteModel,
} from "../../lib/modelPrefs";
import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";
import { Sheet } from "../ui/Sheet";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";

/** Canonical display order for effort tiers. */
const EFFORT_ORDER: readonly ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Effort tiers the app can actually send for this handle: OpenAI takes every
 * catalog tier, Anthropic has no none/minimal tier, and other providers have
 * no effort payload wired up (modelSettingsFor sends the model change alone).
 */
function sendableEfforts(handle: string, efforts: ReasoningEffort[]): ReasoningEffort[] {
  const provider = handle.includes("/") ? handle.split("/")[0] : undefined;
  if (provider === "openai") return EFFORT_ORDER.filter((e) => efforts.includes(e));
  if (provider === "anthropic") return EFFORT_ORDER.filter((e) => e !== "none" && e !== "minimal" && efforts.includes(e));
  return [];
}

interface Props {
  models: ModelOption[];
  currentModel: string | null;
  currentEffort: string | null;
  onSelect: (model: string, effort?: ReasoningEffort) => void;
  error?: string | null;
}

export const ModelSheet = forwardRef<BottomSheetModal, Props>(function ModelSheet(
  { models, currentModel, currentEffort, onSelect, error },
  ref,
) {
  const { colors } = useTheme();
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recents, setRecents] = useState<string[]>([]);
  const [effort, setEffort] = useState<ReasoningEffort | null>(null);
  // Model tapped while the sheet stays open, waiting for an effort choice.
  const [pending, setPending] = useState<ModelOption | null>(null);

  // handle → tiers the catalog ships for it (from the per-variant entries).
  const catalogEfforts = useMemo(() => {
    const map = new Map<string, Set<ReasoningEffort>>();
    for (const m of models) {
      if (!m.effort) continue;
      let set = map.get(m.handle);
      if (!set) map.set(m.handle, (set = new Set()));
      set.add(m.effort);
    }
    return map;
  }, [models]);

  const effortsFor = useCallback(
    (handle: string) => sendableEfforts(handle, [...(catalogEfforts.get(handle) ?? [])]),
    [catalogEfforts],
  );

  // Efforts of the model the segment targets: a pending pick if one is waiting,
  // otherwise the model in use (standalone effort adjustment).
  const effortHandle = pending?.handle ?? currentModel;
  const currentModelEfforts = useMemo(
    () => (effortHandle ? effortsFor(effortHandle) : []),
    [effortHandle, effortsFor],
  );

  // One row per handle (catalog ships per-effort variants under one handle).
  const deduped = useMemo(() => {
    const seen = new Set<string>();
    return models.filter((m) => !seen.has(m.handle) && seen.add(m.handle));
  }, [models]);

  useEffect(() => {
    void loadFavoriteModels().then(setFavorites);
    void loadRecentModels().then(setRecents);
  }, []);

  // Seed the effort selection from the conversation's current tier.
  useEffect(() => {
    setEffort(
      currentEffort && currentModelEfforts.includes(currentEffort as ReasoningEffort)
        ? (currentEffort as ReasoningEffort)
        : null,
    );
  }, [currentEffort, currentModelEfforts]);

  const byHandle = useMemo(() => new Map(deduped.map((m) => [m.handle, m])), [deduped]);

  // Model tap: if the model has effort tiers the sheet stays open so the
  // tier can be picked (pending); otherwise it applies immediately and closes.
  const pressModel = useCallback(
    (m: ModelOption) => {
      const targetEfforts = effortsFor(m.handle);
      if (targetEfforts.length === 0) {
        void pushRecentModel(m.handle).then(setRecents);
        setSearch("");
        onSelect(m.handle, undefined);
        return;
      }
      setPending(m);
      // The effort seed effect re-tiers for the new target automatically.
    },
    [effortsFor, onSelect],
  );

  // Effort tap applies the pending model + tier (or re-tiers the model in
  // use) and closes the sheet via the parent's dismiss-on-select.
  const selectEffort = useCallback(
    (e: ReasoningEffort) => {
      const next = effort === e ? null : e;
      setEffort(next);
      if (!next) return;
      const handle = pending?.handle ?? currentModel;
      if (!handle) return;
      void pushRecentModel(handle).then(setRecents);
      setSearch("");
      onSelect(handle, next);
    },
    [effort, pending, currentModel, onSelect],
  );

  const toggleFavorite = useCallback((handle: string) => {
    void toggleFavoriteModel(handle).then(setFavorites);
  }, []);

  const renderModelRow = useCallback(
    (m: ModelOption) => {
      const selected = currentModel === m.handle;
      const isFavorite = favorites.includes(m.handle);
      return (
        <View key={m.handle} style={styles.modelRow}>
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={`Model ${m.label}${selected ? ", selected" : ""}`}
            onPress={() => pressModel(m)}
            style={styles.modelMain}
          >
            <View style={styles.modelRowInner}>
              <View style={styles.modelText}>
                <Text role="body">{m.label}</Text>
                <Text role="sub" ink={3} mono>
                  {m.handle}
                </Text>
              </View>
              {selected ? (
                <Text role="bodyEm" tone="accent">
                  ✓
                </Text>
              ) : null}
            </View>
          </Touchable>
          <Touchable
            accessibilityRole="button"
            accessibilityLabel={`${isFavorite ? "Unfavorite" : "Favorite"} model ${m.label}`}
            onPress={() => toggleFavorite(m.handle)}
            style={styles.starTouch}
          >
            <Text role="body" tone={isFavorite ? "accent" : undefined} ink={isFavorite ? undefined : 3}>
              {isFavorite ? "★" : "☆"}
            </Text>
          </Touchable>
        </View>
      );
    },
    [currentModel, favorites, pressModel, toggleFavorite],
  );

  const query = search.trim().toLowerCase();
  const filtered = query
    ? deduped.filter((m) => m.label.toLowerCase().includes(query) || m.handle.toLowerCase().includes(query))
    : deduped;
  const favoriteRows = favorites.map((h) => byHandle.get(h)).filter((m): m is ModelOption => Boolean(m));
  const recentRows = recents
    .map((h) => byHandle.get(h))
    .filter((m): m is ModelOption => Boolean(m) && !favorites.includes(m!.handle));

  return (
    <Sheet
      ref={ref}
      title="Model"
      scroll
      onSheetDismiss={() => {
        setPending(null);
        setSearch("");
      }}
    >
      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder="Search models…"
        placeholderTextColor={colors.ink3}
        autoCapitalize="none"
        style={[styles.search, { borderColor: colors.surfaceEdge, color: colors.ink }]}
      />
      {currentModelEfforts.length > 0 ? (
        <View style={styles.effortBlock}>
          <Text role="micro" ink={3}>
            {pending ? `Reasoning effort — ${pending.label}` : "Reasoning effort"}
          </Text>
          <View style={[styles.segment, { borderColor: colors.surfaceEdge }]}>
            {currentModelEfforts.map((e) => (
              <Touchable
                key={e}
                accessibilityRole="button"
                accessibilityLabel={`Effort ${e}${effort === e ? ", selected" : ""}`}
                onPress={() => selectEffort(e)}
                style={[styles.segmentItem, effort === e && { backgroundColor: colors.bubble }]}
              >
                <Text role="sub" ink={effort === e ? 1 : 2} style={styles.segmentLabel}>
                  {e}
                </Text>
              </Touchable>
            ))}
          </View>
          {pending ? (
            <Text role="sub" ink={3}>
              Pick an effort to switch to {pending.label}, or tap another model.
            </Text>
          ) : null}
        </View>
      ) : null}
      {error ? (
        <Text role="sub" tone="danger">
          {error}
        </Text>
      ) : null}
      <View style={styles.listBlock}>
        {query ? (
          <>
            {filtered.slice(0, 12).map(renderModelRow)}
            {filtered.length === 0 ? (
              <Text role="sub" ink={3}>
                No models match “{search.trim()}”.
              </Text>
            ) : null}
          </>
        ) : (
          <>
            {favoriteRows.length > 0 ? (
              <>
                <Text role="micro" ink={3} style={styles.sectionLabel}>
                  Favorites
                </Text>
                {favoriteRows.map(renderModelRow)}
              </>
            ) : null}
            {recentRows.length > 0 ? (
              <>
                <Text role="micro" ink={3} style={styles.sectionLabel}>
                  Recent
                </Text>
                {recentRows.map(renderModelRow)}
              </>
            ) : null}
            <Text role="micro" ink={3} style={styles.sectionLabel}>
              {favoriteRows.length > 0 || recentRows.length > 0 ? "All models" : "Models"}
            </Text>
            {filtered.slice(0, 8).map(renderModelRow)}
          </>
        )}
      </View>
    </Sheet>
  );
});

const styles = StyleSheet.create({
  search: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: 9,
    fontSize: 15,
  },
  effortBlock: { gap: space.sm },
  segment: {
    flexDirection: "row",
    flexWrap: "wrap",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    overflow: "hidden",
  },
  segmentItem: { flexGrow: 1, flexBasis: "16%", minHeight: 38, alignItems: "center" },
  segmentLabel: { textTransform: "capitalize", fontSize: 12 },
  listBlock: { gap: 2 },
  sectionLabel: { paddingTop: space.sm, paddingBottom: 2 },
  modelRow: { flexDirection: "row", alignItems: "center", minHeight: 46 },
  modelMain: { flex: 1 },
  modelRowInner: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6 },
  modelText: { flex: 1, gap: 1 },
  starTouch: { paddingHorizontal: space.sm, paddingVertical: space.xs },
});
