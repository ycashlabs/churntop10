import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { RuleHistoryView, RuleView, ReviewScreen, SessionView, SimulatorView, Summary } from "../lib/api-types";

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
    const required = (body as { stepUpMethod?: string }).stepUpMethod === "passkey" ? "passkey" : "any";
    const ok = await stepUp(required);
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

export async function passkeyStepUp(): Promise<boolean> {
  try {
    const started = await api<{ options: AuthenticationOptions; challengeId: string }>("/api/auth/login/options", { method: "POST" }, false);
    const response = await startAuthentication({ optionsJSON: started.options });
    await api("/api/auth/login/verify", { method: "POST", body: JSON.stringify({ challengeId: started.challengeId, response, stepUp: true }) }, false);
    return true;
  } catch {
    return false;
  }
}

export async function totpStepUp(code: string, backup = false): Promise<void> {
  const path = backup ? "/api/auth/login/backup" : "/api/auth/login/totp";
  await api(path, { method: "POST", body: JSON.stringify({ code, stepUp: true }) }, false);
}

export async function signInWithTotp(code: string, backup = false): Promise<void> {
  const path = backup ? "/api/auth/login/backup" : "/api/auth/login/totp";
  await api(path, { method: "POST", body: JSON.stringify({ code }) });
}

export async function beginTotp(): Promise<{ otpauthUri: string; setupKey: string }> {
  return api("/api/auth/totp/begin", { method: "POST" });
}

export async function confirmTotp(code: string): Promise<{ backupCodes: string[] }> {
  return api("/api/auth/totp/confirm", { method: "POST", body: JSON.stringify({ code }) });
}

export async function disableTotp(): Promise<void> {
  await api("/api/auth/totp/disable", { method: "POST", body: "{}" });
}

type StepUpPrompt = (required: "passkey" | "any") => Promise<boolean>;
let stepUpPrompt: StepUpPrompt = () => passkeyStepUp();

export function setStepUpPrompt(prompt: StepUpPrompt): void {
  stepUpPrompt = prompt;
}

async function stepUp(required: "passkey" | "any" = "any"): Promise<boolean> {
  return stepUpPrompt(required);
}

export function post(path: string, body?: unknown): Promise<Summary> {
  return api<Summary>(path, { method: "POST", body: body === undefined ? "{}" : JSON.stringify(body) });
}

export interface PendingConnect {
  pending: boolean;
  expiresAt?: string;
  redirectUri: string;
}

export function getPendingConnect(): Promise<PendingConnect> {
  return api<PendingConnect>("/api/robinhood/pending");
}

export function getSimulator(): Promise<SimulatorView> {
  return api<SimulatorView>("/api/simulator");
}

export function getRules(): Promise<{ rules: RuleView[] }> {
  return api<{ rules: RuleView[] }>("/api/rules");
}

export function getRuleHistory(familyId: string): Promise<{ history: RuleHistoryView[] }> {
  return api<{ history: RuleHistoryView[] }>(`/api/rules/${familyId}/history`);
}

export function postJson<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: body === undefined ? "{}" : JSON.stringify(body) });
}

export function getReviews(query: Record<string, string> = {}): Promise<ReviewScreen> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) params.set(key, value);
  }
  const suffix = params.toString() ? `?${params}` : "";
  return api<ReviewScreen>(`/api/reviews${suffix}`);
}
