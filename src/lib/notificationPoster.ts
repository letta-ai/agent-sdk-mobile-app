import AsyncStorage from '@react-native-async-storage/async-storage';
const NOTIF_PERM_ASKED_KEY = "letta.notif-perm-asked";

/**
 * NotificationPoster — platform bridge for posting local notifications.
 * Adapted from the KMP client's NotificationPoster (expect/actual pattern),
 * implemented with expo-notifications for React Native.
 */
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

const CHANNEL_ID = "conversations";

/** Configure the notification handler (call once at app startup). */
export async function configureNotifications(): Promise<void> {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

/** Ensure the notification channel exists (safe to call repeatedly). */
export async function ensureChannel(): Promise<void> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: "Conversations",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#FF231F7B",
    });
  }
}

/**
 * Request notification permission — at most ONCE per install. Android 13+
 * requires the runtime ask before any notification shows, but re-asking on
 * every conversation open after a denial is nagging, not prompting: the OS
 * itself permanently denies after the user's second refusal, so a repeated
 * request can never succeed and only erodes trust.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  const { status: existing } = await Notifications.getPermissionsAsync();
  if (existing === "granted") return true;
  const asked = await AsyncStorage.getItem(NOTIF_PERM_ASKED_KEY);
  if (asked) return false;
  await AsyncStorage.setItem(NOTIF_PERM_ASKED_KEY, "1");
  const { status } = await Notifications.requestPermissionsAsync();
  return status === "granted";
}

/** True when the OS will show our notifications (permission granted). */
export async function canPost(): Promise<boolean> {
  const { status } = await Notifications.getPermissionsAsync();
  return status === "granted";
}

/** Post a conversation notification. No-ops when permission is missing. */
export async function postConversationNotification(
  conversationId: string,
  title: string,
  text: string,
): Promise<void> {
  const granted = await canPost();
  if (!granted) return;
  await ensureChannel();
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body: text,
      data: { conversationId },
    },
    trigger: null, // Immediate
  });
}
