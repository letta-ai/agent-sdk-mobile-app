/**
 * Per-user model picker preferences: favorite (saved) models and recently
 * used models. Stored app-wide by handle, so they apply across servers
 * (handles include the provider prefix).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const FAV_KEY = "letta.models.favorites";
const RECENT_KEY = "letta.models.recent";
const RECENT_CAP = 5;

async function readList(key: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

async function writeList(key: string, handles: string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(handles));
  } catch {
    // Preferences are best-effort — a failed write just loses the update.
  }
}

export function loadFavoriteModels(): Promise<string[]> {
  return readList(FAV_KEY);
}

/** Toggle a handle's favorite status; returns the new favorites list. */
export async function toggleFavoriteModel(handle: string): Promise<string[]> {
  const current = await readList(FAV_KEY);
  const next = current.includes(handle) ? current.filter((h) => h !== handle) : [...current, handle];
  await writeList(FAV_KEY, next);
  return next;
}

export function loadRecentModels(): Promise<string[]> {
  return readList(RECENT_KEY);
}

/** Move a handle to the front of the recents list (deduped, capped). */
export async function pushRecentModel(handle: string): Promise<string[]> {
  const current = await readList(RECENT_KEY);
  const next = [handle, ...current.filter((h) => h !== handle)].slice(0, RECENT_CAP);
  await writeList(RECENT_KEY, next);
  return next;
}
