/**
 * Connection profiles — the app's core product object (docs/design-doc.md §4.1).
 *
 * A profile is either a Letta Cloud connection (API key) or a remote
 * app-server connection (WebSocket URL + capability token). Non-secret
 * metadata lives in AsyncStorage; secrets live only in expo-secure-store,
 * keyed by profile id, and are never logged, rendered, or exported.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

import {
  parseOAuthCredential,
  refreshOAuthCredential,
  revokeOAuthCredential,
  type OAuthCredential,
} from "../auth/oauthTokens";

export type ProfileType = "cloud" | "remote";
export type CloudAuthMethod = "oauth" | "api_key";

/**
 * Selector for the computer where cloud sessions execute tools. Mirrors the
 * SDK's `ComputerSelector` — a string name, or an object with
 * deviceId/id/connectionId. When absent, the SDK provisions a managed sandbox.
 */
export type ComputerSelectorField = string | { name: string } | { deviceId: string } | { id: string } | { connectionId: string; name?: string };

export interface Profile {
  id: string;
  type: ProfileType;
  name: string;
  /** Cloud: API base URL (default https://api.letta.com). Remote: WebSocket URL. */
  url: string;
  /** Existing Cloud profiles omit this field and remain API-key profiles. */
  authMethod?: CloudAuthMethod;
  /**
   * Cloud only: which computer/environment sessions execute on. When absent,
   * the SDK provisions a managed sandbox. Stored per-profile because
   * environments are tied to the cloud account, not individual conversations.
   */
  computerSelector?: ComputerSelectorField;
  /** Result of the last "Test connection" run. */
  lastTest?: "ok" | "unauthorized" | "unreachable";
  createdAt: number;
}

const INDEX_KEY = "letta.profiles.v1";
const ACTIVE_KEY = "letta.profiles.active.v1";
const secretKey = (id: string) => `letta.secret.${id}`;
const credentialRefreshes = new Map<string, Promise<string>>();
const deletingProfiles = new Set<string>();

export const CLOUD_DEFAULT_URL = "https://api.letta.com";

export async function listProfiles(): Promise<Profile[]> {
  const raw = await AsyncStorage.getItem(INDEX_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Profile[];
  } catch {
    return [];
  }
}

async function writeProfiles(profiles: Profile[]): Promise<void> {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(profiles));
}

export async function saveProfile(profile: Profile, secret: string | null): Promise<void> {
  const profiles = await listProfiles();
  const index = profiles.findIndex((p) => p.id === profile.id);
  if (index === -1) profiles.push(profile);
  else profiles[index] = profile;
  await writeProfiles(profiles);
  // Empty secret means "keep the stored one" when editing.
  if (secret !== null && secret.length > 0) {
    await SecureStore.setItemAsync(secretKey(profile.id), secret);
  }
}

export async function saveOAuthProfile(
  profile: Profile,
  credential: OAuthCredential,
): Promise<void> {
  await saveProfile(
    { ...profile, type: "cloud", url: CLOUD_DEFAULT_URL, authMethod: "oauth" },
    JSON.stringify(credential),
  );
}

export async function deleteProfile(id: string): Promise<void> {
  deletingProfiles.add(id);
  try {
    // A refresh can rotate the refresh token. Wait for it, then revoke the
    // newest stored credential so deletion cannot leave a valid session or
    // let the refresh write the credential back after local cleanup.
    try {
      await credentialRefreshes.get(id);
    } catch {
      // Revoke the last stored credential below when refresh fails.
    }
    const stored = await SecureStore.getItemAsync(secretKey(id));
    const oauth = stored ? parseOAuthCredential(stored) : null;
    if (oauth) {
      try {
        await revokeOAuthCredential(oauth);
      } catch {
        // Local deletion must still work when the account is offline.
      }
    }
    const profiles = (await listProfiles()).filter((p) => p.id !== id);
    await writeProfiles(profiles);
    await SecureStore.deleteItemAsync(secretKey(id));
    if ((await getActiveProfileId()) === id) {
      await AsyncStorage.removeItem(ACTIVE_KEY);
    }
  } finally {
    deletingProfiles.delete(id);
  }
}

/** Secrets never leave this module except through this call at connect time. */
export async function getSecret(id: string): Promise<string | null> {
  if (deletingProfiles.has(id)) return null;
  const stored = await SecureStore.getItemAsync(secretKey(id));
  if (!stored || deletingProfiles.has(id)) return null;
  const oauth = parseOAuthCredential(stored);
  if (!oauth) return stored;
  if (oauth.expiresAt > Date.now() + 5 * 60 * 1000) return oauth.accessToken;
  const currentRefresh = credentialRefreshes.get(id);
  if (currentRefresh) return currentRefresh;
  const refresh = refreshOAuthCredential(oauth)
    .then(async (refreshed) => {
      await SecureStore.setItemAsync(secretKey(id), JSON.stringify(refreshed));
      return refreshed.accessToken;
    })
    .finally(() => credentialRefreshes.delete(id));
  credentialRefreshes.set(id, refresh);
  return refresh;
}

export async function hasSecret(id: string): Promise<boolean> {
  return (await SecureStore.getItemAsync(secretKey(id))) !== null;
}

export async function getActiveProfileId(): Promise<string | null> {
  return AsyncStorage.getItem(ACTIVE_KEY);
}

export async function setActiveProfileId(id: string): Promise<void> {
  await AsyncStorage.setItem(ACTIVE_KEY, id);
}

export function newProfileId(): string {
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
