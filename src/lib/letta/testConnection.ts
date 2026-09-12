/**
 * "Test connection" — a real handshake with a specific verdict, run before a
 * profile can be saved (docs/design-doc.md §4.1).
 *
 * Cloud: an authenticated REST call to the Letta API.
 * Remote: a WebSocket upgrade to the app-server control channel. React
 * Native's WebSocket accepts headers via its third argument, so the
 * capability token rides the upgrade request like the SDK's Node path.
 */
import type { ProfileType } from "../profiles/profiles";

export type TestResult =
  | { ok: true; detail: string }
  | { ok: false; reason: "unauthorized" | "unreachable" | "invalid_url"; detail: string };

const TIMEOUT_MS = 8000;

export async function testConnection(
  type: ProfileType,
  url: string,
  secret: string,
): Promise<TestResult> {
  return type === "cloud" ? testCloud(url, secret) : testRemote(url, secret);
}

async function testCloud(baseUrl: string, apiKey: string): Promise<TestResult> {
  let target: string;
  try {
    target = new URL("/v1/agents/?limit=1", baseUrl).toString();
  } catch {
    return { ok: false, reason: "invalid_url", detail: "That URL doesn't look valid." };
  }
  try {
    const response = await fetch(target, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "unauthorized", detail: "Your credentials were rejected." };
    }
    if (!response.ok) {
      return { ok: false, reason: "unreachable", detail: `The server answered ${response.status}.` };
    }
    return { ok: true, detail: "Connected to Letta Cloud." };
  } catch {
    return { ok: false, reason: "unreachable", detail: "Couldn't reach the server." };
  }
}

function testRemote(wsUrl: string, token: string): Promise<TestResult> {
  let target: URL;
  try {
    target = new URL(wsUrl);
    if (target.protocol === "http:") target.protocol = "ws:";
    if (target.protocol === "https:") target.protocol = "wss:";
    if (target.protocol !== "ws:" && target.protocol !== "wss:") {
      return Promise.resolve({
        ok: false,
        reason: "invalid_url",
        detail: "Use a ws:// or wss:// URL.",
      });
    }
  } catch {
    return Promise.resolve({ ok: false, reason: "invalid_url", detail: "That URL doesn't look valid." });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: TestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(result);
    };

    // RN's WebSocket takes request options as a third argument; the TS lib
    // type only declares two, so widen the constructor.
    const RNWebSocket = WebSocket as unknown as new (
      url: string,
      protocols?: string | string[] | null,
      options?: { headers?: Record<string, string> },
    ) => WebSocket;
    const socket = new RNWebSocket(
      target.toString(),
      undefined,
      token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    );
    const timer = setTimeout(
      () => finish({ ok: false, reason: "unreachable", detail: "The server didn't answer in time." }),
      TIMEOUT_MS,
    );

    socket.onopen = () => finish({ ok: true, detail: "Connected to the app-server." });
    socket.onclose = (event) => {
      // An upgrade rejected for auth closes with a policy code before opening.
      if (event.code === 1008 || event.code === 4001 || event.code === 4003) {
        finish({ ok: false, reason: "unauthorized", detail: "The token was rejected." });
      } else {
        finish({ ok: false, reason: "unreachable", detail: "The server closed the connection." });
      }
    };
    socket.onerror = () =>
      finish({ ok: false, reason: "unreachable", detail: "Couldn't reach the server." });
  });
}
