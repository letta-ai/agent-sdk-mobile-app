/**
 * Environment selector sheet — lists available computers (local backends)
 * registered with the Letta Cloud account, plus a "Cloud Sandbox" default.
 * Cloud profiles can route sessions to a specific computer or let the SDK
 * provision a managed sandbox.
 */
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { forwardRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import type { ComputerSummary } from "../../lib/letta/api";
import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";
import { Sheet } from "../ui/Sheet";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";

interface Props {
  computers: ComputerSummary[];
  /** Currently selected connectionId, or null for cloud sandbox. */
  selectedConnectionId: string | null;
  onSelect: (connectionId: string | null, name: string | null) => void;
  loading?: boolean;
  error?: string | null;
}

export const EnvironmentSheet = forwardRef<BottomSheetModal, Props>(function EnvironmentSheet(
  { computers, selectedConnectionId, onSelect, loading, error },
  ref,
) {
  const { colors } = useTheme();
  const [dismissing, setDismissing] = useState(false);

  const handleSelect = (connectionId: string | null, name: string | null) => {
    setDismissing(true);
    onSelect(connectionId, name);
    (ref as React.RefObject<BottomSheetModal>)?.current?.dismiss();
    setDismissing(false);
  };

  // Deduplicate by deviceId — the environments API returns multiple stale
  // connection leases for the same physical device. Keep only the first
  // online entry per device. Offline entries are hidden (can't route to them).
  const seen = new Set<string>();
  const onlineComputers = computers.filter((c) => {
    if (c.status !== "online" || !c.connectionId) return false;
    if (seen.has(c.deviceId)) return false;
    seen.add(c.deviceId);
    return true;
  });

  return (
    <Sheet ref={ref} title="Environment">
      {loading ? (
        <Text role="sub" ink={3}>
          Loading environments…
        </Text>
      ) : error ? (
        <Text role="sub" tone="danger">
          {error}
        </Text>
      ) : null}

      {/* Cloud Sandbox (SDK default) */}
      <View style={styles.section}>
        <Touchable
          accessibilityRole="button"
          accessibilityLabel={`Cloud Sandbox${selectedConnectionId === null ? ", selected" : ""}`}
          onPress={() => handleSelect(null, null)}
          disabled={dismissing}
          style={styles.row}
        >
          <View style={styles.rowInner}>
            <View style={styles.rowText}>
              <Text role="body">Cloud Sandbox</Text>
              <Text role="sub" ink={3}>
                SDK-managed ephemeral sandbox
              </Text>
            </View>
            {selectedConnectionId === null ? (
              <Text role="bodyEm" tone="accent">
                ✓
              </Text>
            ) : null}
          </View>
        </Touchable>
      </View>

      {/* Online computers */}
      {onlineComputers.length > 0 ? (
        <View style={styles.section}>
          <Text role="micro" ink={3} style={styles.sectionLabel}>
            ONLINE
          </Text>
          {onlineComputers.map((c) => {
            const selected = selectedConnectionId === c.connectionId;
            return (
              <Touchable
                key={c.connectionId}
                accessibilityRole="button"
                accessibilityLabel={`${c.name}${selected ? ", selected" : ""}`}
                onPress={() => handleSelect(c.connectionId, c.name)}
                disabled={dismissing}
                style={styles.row}
              >
                <View style={styles.rowInner}>
                  <View style={styles.rowText}>
                    <Text role="body">{c.name}</Text>
                    <Text role="sub" ink={3} mono>
                      {c.connectionId?.slice(0, 8) ?? ""}
                    </Text>
                  </View>
                  <View style={styles.statusWrap}>
                    <View style={[styles.statusDot, { backgroundColor: "#34a853" }]} />
                    {selected ? (
                      <Text role="bodyEm" tone="accent">
                        ✓
                      </Text>
                    ) : null}
                  </View>
                </View>
              </Touchable>
            );
          })}
        </View>
      ) : null}

      {!loading && onlineComputers.length === 0 && !error ? (
        <Text role="sub" ink={3}>
          No computers online. Start the Letta Code desktop app on a device to connect it.
        </Text>
      ) : null}
    </Sheet>
  );
});

const styles = StyleSheet.create({
  section: { gap: 2 },
  sectionLabel: { paddingTop: space.sm, paddingBottom: space.xs, textTransform: "uppercase" },
  row: { minHeight: 46 },
  rowInner: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 6 },
  rowText: { flex: 1, gap: 1 },
  statusWrap: { flexDirection: "row", alignItems: "center", gap: space.sm },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
});
