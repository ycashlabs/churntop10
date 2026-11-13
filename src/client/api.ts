import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { SessionView, Summary } from "../lib/api-types";

let csrf = "";

export async function loadCsrf(): Promise<void> {
  const response = await fetch("/api/csrf", { credentials: "same-origin" });
  const body = await response.json() as { csrfToken?: string };
  csrf = body.csrfToken ?? "";
}

export async function api<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (csrf) headers.set("x-csrf-token", csrf);
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const body = await response.json().catch(() => ({})) as T & { error?: string; stepUp?: boolean; csrfToken?: string };
  if (body.csrfToken) csrf = body.csrfToken;
  if (response.status === 403 && body.stepUp && retry) {
    const ok = await stepUp();
    if (!ok) throw new Error(body.error || "Passkey confirmation failed.");
    return api<T>(path, init, false);
  }
  if (!response.ok) throw new Error(body.error || "Request failed.");
  return body;
}

export function getSession(): Promise<SessionView> {
  return api<SessionView>("/api/session");
}

export function getSummary(): Promise<Summary> {
  return api<Summary>("/api/summary");
}

type RegistrationOptions = Parameters<typeof startRegistration>[0]["optionsJSON"];
type AuthenticationOptions = Parameters<typeof startAuthentication>[0]["optionsJSON"];

export async function registerPasskey(): Promise<void> {
  const started = await api<{ options: RegistrationOptions; ownerId: string }>("/api/auth/register/options", { method: "POST" });
  const response = await startRegistration({ optionsJSON: started.options });
  await api("/api/auth/register/verify", { method: "POST", body: JSON.stringify({ ownerId: started.ownerId, response }) });
}

export async function signIn(): Promise<void> {
  const started = await api<{ options: AuthenticationOptions; challengeId: string }>("/api/auth/login/options", { method: "POST" });
  const response = await startAuthentication({ optionsJSON: started.options });
  await api("/api/auth/login/verify", { method: "POST", body: JSON.stringify({ challengeId: started.challengeId, response }) });
}

async function stepUp(): Promise<boolean> {
  try {
    const started = await api<{ options: AuthenticationOptions; challengeId: string }>("/api/auth/login/options", { method: "POST" }, false);
    const response = await startAuthentication({ optionsJSON: started.options });
    await api("/api/auth/login/verify", { method: "POST", body: JSON.stringify({ challengeId: started.challengeId, response, stepUp: true }) }, false);
    return true;
  } catch {
    return false;
  }
}

export function post(path: string, body?: unknown): Promise<Summary> {
  return api<Summary>(path, { method: "POST", body: body === undefined ? "{}" : JSON.stringify(body) });
}
