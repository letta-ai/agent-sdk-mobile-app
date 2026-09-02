/**
 * Compact dropdown — label + value row that expands in place with the
 * options. Keeps settings sheets short (full-height option lists became a
 * scroll exercise; see docs/design-doc.md §4.5).
 */
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";
import { Text } from "./Text";
import { Touchable } from "./Touchable";

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  detail?: string;
  danger?: boolean;
}

interface Props<T extends string> {
  label: string;
  value: T | null;
  options: DropdownOption<T>[];
  onSelect: (value: T) => void;
}

export function Dropdown<T extends string>({ label, value, options, onSelect }: Props<T>) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value) ?? null;

  return (
    <View style={styles.block}>
      <Text role="micro" ink={3}>
        {label}
      </Text>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${selected?.label ?? "Not set"}${open ? ", expanded" : ""}`}
        onPress={() => setOpen((v) => !v)}
        style={[styles.trigger, { borderColor: colors.surfaceEdge }]}
      >
        <View style={styles.triggerInner}>
          <View style={styles.triggerText}>
            <Text role="body">{selected?.label ?? "Not set"}</Text>
            {selected?.detail ? (
              <Text role="sub" ink={3}>
                {selected.detail}
              </Text>
            ) : null}
          </View>
          <Text role="body" ink={3}>
            {open ? "▴" : "▾"}
          </Text>
        </View>
      </Touchable>
      {open
        ? options.map((o) => (
            <Touchable
              key={o.value}
              accessibilityRole="button"
              accessibilityLabel={`${o.label}${o.value === value ? ", selected" : ""}`}
              onPress={() => {
                onSelect(o.value);
                setOpen(false);
              }}
              style={[styles.option, o.value === value && { backgroundColor: colors.bubble }]}
            >
              <View style={styles.triggerInner}>
                <View style={styles.triggerText}>
                  <Text role="body" tone={o.danger ? "danger" : undefined}>
                    {o.label}
                  </Text>
                  {o.detail ? (
                    <Text role="sub" ink={3}>
                      {o.detail}
                    </Text>
                  ) : null}
                </View>
                {o.value === value ? (
                  <Text role="bodyEm" tone="accent">
                    ✓
                  </Text>
                ) : null}
              </View>
            </Touchable>
          ))
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: space.xs },
  trigger: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.row,
    paddingHorizontal: space.md,
    paddingVertical: 9,
  },
  triggerInner: { flexDirection: "row", alignItems: "center", gap: space.sm },
  triggerText: { flex: 1, gap: 1 },
  option: { paddingHorizontal: space.md, paddingVertical: 8, borderRadius: radius.row, minHeight: 42 },
});
