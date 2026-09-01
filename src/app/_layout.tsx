/**
 * Root layout: gesture root → theme → navigation stack.
 * Router chrome is disabled; screens render their own headers (Screen/Header)
 * so the design system owns every pixel.
 */
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { ProfilesProvider, useProfiles } from "../lib/profiles/ProfilesContext";
import { startBackgroundPollingForProfile } from "../lib/backgroundPolling";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider";

/**
 * Root-level polling lifecycle. The native poller runs for the app's whole
 * lifetime — foregrounded too — so "All messages" notifications fire even
 * while the app is open on another screen. Per-conversation suppression is
 * handled by the chat screen reporting the visible conversation.
 */
function BackgroundPollingLifecycle() {
  const { activeProfile } = useProfiles();
  const profileRef = useRef(activeProfile);
  profileRef.current = activeProfile;

  useEffect(() => {
    void startBackgroundPollingForProfile(profileRef.current);
    const sub = AppState.addEventListener("change", () => {
      void startBackgroundPollingForProfile(profileRef.current);
    });
    return () => sub.remove();
  }, [activeProfile]);

  return null;
}

function ThemedStack() {
  const { name, colors } = useTheme();
  return (
    <>
      <StatusBar style={name === "dark" ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
          animation: "slide_from_right",
        }}
      />
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <ProfilesProvider>
          <BottomSheetModalProvider>
            <BackgroundPollingLifecycle />
            <ThemedStack />
          </BottomSheetModalProvider>
        </ProfilesProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
