/**
 * Bottom sheet wrapper — the app's one sheet treatment (docs/design-doc.md
 * §4.5): 24pt top radius, blur backdrop, drag-to-dismiss, title row.
 *
 * Keyboard: the app is edge-to-edge (targetSdk 36), so Android never resizes
 * the window for the IME and @gorhom/bottom-sheet's built-in keyboardBehavior
 * stays a no-op. Instead the sheet's bottom padding grows by the keyboard
 * height while it's visible — dynamic sizing re-measures the content and the
 * whole sheet (search inputs included) rides above the keyboard.
 */
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetScrollView, BottomSheetView, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";
import { forwardRef, useCallback, useEffect, useState, type ReactNode, type RefObject } from "react";
import { BackHandler, Keyboard, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useTheme } from "../../theme/ThemeProvider";
import { radius, space } from "../../theme/tokens";
import { Text } from "./Text";

interface Props {
  title: string;
  children: ReactNode;
  /** Content of unbounded height (tool payloads): dynamic sizing caps at the
   *  screen and the body scrolls with the sheet-aware scrollable. */
  scroll?: boolean;
  /** Fires after the sheet closes (dismiss, drag, back) — reset transient state here. */
  onSheetDismiss?: () => void;
}

export const Sheet = forwardRef<BottomSheetModal, Props>(function Sheet({ title, children, scroll, onSheetDismiss }, ref) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Android hardware back dismisses the sheet instead of popping the screen.
  // Callers always pass useRef objects, so the ForwardedRef cast is safe here.
  const sheetRef = ref as RefObject<BottomSheetModal | null>;
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      sheetRef.current?.dismiss();
      return true;
    });
    return () => sub.remove();
  }, [open, sheetRef]);

  // Track the IME so the sheet content can grow above it (see header note).
  useEffect(() => {
    const showSub = Keyboard.addListener("keyboardDidShow", (e) => setKeyboardHeight(e.endCoordinates.height));
    const hideSub = Keyboard.addListener("keyboardDidHide", () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const handleChange = useCallback((index: number) => {
    setOpen(index >= 0);
  }, []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.45} />
    ),
    [],
  );

  const bottomPadding = Math.max(insets.bottom, space.lg) + keyboardHeight;

  return (
    <BottomSheetModal
      ref={ref}
      enableDynamicSizing
      enablePanDownToClose
      onChange={handleChange}
      onDismiss={onSheetDismiss}
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: colors.surface, borderRadius: radius.sheet }}
      handleIndicatorStyle={{ backgroundColor: colors.ink3, width: 36 }}
    >
      {scroll ? (
        <BottomSheetScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomPadding }]}>
          <View style={styles.titleRow}>
            <Text role="title">{title}</Text>
          </View>
          {children}
        </BottomSheetScrollView>
      ) : (
        <BottomSheetView style={[styles.content, { paddingBottom: bottomPadding }]}>
          <View style={styles.titleRow}>
            <Text role="title">{title}</Text>
          </View>
          {children}
        </BottomSheetView>
      )}
    </BottomSheetModal>
  );
});

const styles = StyleSheet.create({
  content: { paddingHorizontal: space.gutter, gap: space.md },
  titleRow: { paddingTop: space.xs, paddingBottom: space.xs },
});
