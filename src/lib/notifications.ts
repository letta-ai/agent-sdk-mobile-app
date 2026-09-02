/**
 * Per-conversation notification settings.
 *
 * Two levels: conversation → app default. A conversation's setting is either
 * concrete (OFF / ALL_MESSAGES / MOBILE_ONLY) or APP_DEFAULT (inherit the
 * app-level master, which is always concrete).
 *
 * AsyncStorage keys:
 *   letta.notif.<conversationId>  — per-conversation setting
 *   letta.notif.appDefault        — app-level master setting
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

/** Notification setting values. Concrete values fire; APP_DEFAULT inherits. */
export enum NotificationMode {
  OFF = "OFF",
  /** Run completion for runs started from ANY source (this app, desktop, CLI, web). */
  ALL_MESSAGES = "ALL_MESSAGES",
  /** Run completion only for runs started by a message from THIS app. */
  MOBILE_ONLY = "MOBILE_ONLY",
  // --- inheritance marker (never fires; resolves upward) ---
  APP_DEFAULT = "APP_DEFAULT",
}

const CONCRETE = new Set<NotificationMode>([
  NotificationMode.OFF,
  NotificationMode.ALL_MESSAGES,
  NotificationMode.MOBILE_ONLY,
]);

export function isConcrete(mode: NotificationMode): boolean {
  return CONCRETE.has(mode);
}

/** Human-readable label for UI. */
export function labelFor(mode: NotificationMode): string {
  switch (mode) {
    case NotificationMode.OFF:
      return "Off";
    case NotificationMode.ALL_MESSAGES:
      return "All messages";
    case NotificationMode.MOBILE_ONLY:
      return "Mobile only";
    default:
      return "App default";
  }
}

/** Resolve a conversation setting against the app default. */
export function resolveMode(
  conversationSetting: NotificationMode,
  appSetting: NotificationMode,
): NotificationMode {
  return isConcrete(conversationSetting) ? conversationSetting : appSetting;
}

const CONV_PREFIX = "letta.notif.";
const APP_KEY = "letta.notif.appDefault";

export async function loadConversationSetting(conversationId: string): Promise<NotificationMode> {
  try {
    const raw = await AsyncStorage.getItem(CONV_PREFIX + conversationId);
    if (raw && Object.values(NotificationMode).includes(raw as NotificationMode)) {
      return raw as NotificationMode;
    }
  } catch {
    // Storage failure reads as "unset" — inherit the app default.
  }
  return NotificationMode.APP_DEFAULT;
}

export async function saveConversationSetting(
  conversationId: string,
  mode: NotificationMode,
): Promise<void> {
  await AsyncStorage.setItem(CONV_PREFIX + conversationId, mode);
}

export async function loadAppDefault(): Promise<NotificationMode> {
  try {
    const raw = await AsyncStorage.getItem(APP_KEY);
    if (raw && Object.values(NotificationMode).includes(raw as NotificationMode)) {
      return raw as NotificationMode;
    }
  } catch {
    // Fall through to the default.
  }
  // Default: all messages — a chat app should notify by default.
  return NotificationMode.ALL_MESSAGES;
}

export async function saveAppDefault(mode: NotificationMode): Promise<void> {
  await AsyncStorage.setItem(APP_KEY, mode);
}
