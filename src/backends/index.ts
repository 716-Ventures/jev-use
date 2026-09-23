/**
 * Backend selection. Explicit `JEV_BACKEND` wins; otherwise the first
 * credential found decides: TypeSafe direct → OpenRouter → Vercel AI
 * Gateway. `mock` must be asked for explicitly — it never engages on its
 * own, so a missing key is a loud, named error instead of silent fakery.
 */

import { MockBackend } from "./mock.js";
import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";
import { OpenRouterBackend } from "./openrouter.js";
import { TypeSafeBackend } from "./typesafe.js";
import { UnconfiguredBackend } from "./unconfigured.js";
import { VercelBackend } from "./vercel.js";
import type { JevBackend } from "./types.js";

/** The backends that ship with jev-use. */
export type BackendName = "typesafe" | "openrouter" | "vercel" | "mock";

/** A backend plus the story of how it was chosen. */
export interface ResolvedBackend {
  backend: JevBackend;
  /** How the choice was made, for `jev-use doctor` and startup logs. */
  via: string;
}

/**
 * Resolve the backend to judge with. `name` (or `JEV_BACKEND`) forces one;
 * without it, the first credential present in `env` wins. Throws a named
 * error when nothing is configured — silence here would look like Jev
 * answering when nothing did.
 */
export function createBackend(
  name?: string,
  env: Record<string, string | undefined> = process.env,
): ResolvedBackend {
  const requested = (name ?? env.JEV_BACKEND)?.toLowerCase();

  switch (requested) {
    case undefined:
    case "":
    case "auto":
      break;
    case "typesafe":
      return { backend: typesafe(env), via: "explicit: typesafe" };
    case "openrouter":
      return { backend: openrouter(env), via: "explicit: openrouter" };
    case "vercel":
      return { backend: vercel(env), via: "explicit: vercel" };
    case "mock":
      return {
        backend: new MockBackend(),
        via: "explicit: mock (no real Jev calls)",
      };
    default:
      throw new Error(
        `Unknown backend "${requested}". Valid: typesafe | openrouter | vercel | mock.`,
      );
  }

  if (env.TYPESAFE_API_KEY || env.TYPESAFE_AI_API_KEY || env.JEV_TYPESAFE_KEYCHAIN_SERVICE) {
    return { backend: typesafe(env), via: "auto: TYPESAFE_API_KEY found" };
  }
  if (env.OPENROUTER_API_KEY) {
    return { backend: openrouter(env), via: "auto: OPENROUTER_API_KEY found" };
  }
  if (env.AI_GATEWAY_API_KEY) {
    return { backend: vercel(env), via: "auto: AI_GATEWAY_API_KEY found" };
  }
  throw new Error(
    "No Jev credentials found. Set one of TYPESAFE_API_KEY (direct), " +
      "OPENROUTER_API_KEY, or AI_GATEWAY_API_KEY (Vercel AI Gateway) — " +
      "or run with JEV_BACKEND=mock for a keyless dry run.",
  );
}

function typesafe(env: Record<string, string | undefined>): TypeSafeBackend {
  const apiKey = env.TYPESAFE_API_KEY ?? env.TYPESAFE_AI_API_KEY ?? keychainKey(env);
  if (!apiKey) throw new Error("JEV_BACKEND=typesafe needs TYPESAFE_API_KEY.");
  return new TypeSafeBackend({
    ...transport(env),
    apiKey,
    baseUrl: env.TYPESAFE_BASE_URL,
    defaultModel: env.JEV_MODEL ?? env.TYPESAFE_DEFAULT_MODEL,
  });
}

function keychainKey(env: Record<string, string | undefined>): string | undefined {
  const service = env.JEV_TYPESAFE_KEYCHAIN_SERVICE;
  if (!service) return undefined;
  if (process.platform !== "darwin") throw new Error("JEV_TYPESAFE_KEYCHAIN_SERVICE requires macOS.");
  const account = env.USER || userInfo().username;
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-a", account, "-s", service, "-w"], {
      encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(`Could not read TypeSafe API key from Keychain service "${service}".`);
  }
}

function openrouter(env: Record<string, string | undefined>): OpenRouterBackend {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("JEV_BACKEND=openrouter needs OPENROUTER_API_KEY.");
  return new OpenRouterBackend({
    ...transport(env),
    apiKey,
    baseUrl: env.OPENROUTER_BASE_URL,
    defaultModel: env.JEV_MODEL,
  });
}

function vercel(env: Record<string, string | undefined>): VercelBackend {
  const apiKey = env.AI_GATEWAY_API_KEY;
  if (!apiKey) throw new Error("JEV_BACKEND=vercel needs AI_GATEWAY_API_KEY.");
  return new VercelBackend({
    ...transport(env),
    apiKey,
    baseUrl: env.AI_GATEWAY_BASE_URL,
    defaultModel: env.JEV_MODEL,
  });
}

function transport(env: Record<string, string | undefined>): { timeoutMs?: number; maxRetries?: number } {
  const timeout = Number(env.JEV_HTTP_TIMEOUT_MS);
  const retries = Number(env.JEV_HTTP_RETRIES);
  return {
    ...(env.JEV_HTTP_TIMEOUT_MS && Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
    ...(env.JEV_HTTP_RETRIES && Number.isInteger(retries) && retries >= 0 ? { maxRetries: retries } : {}),
  };
}

/**
 * Backend resolution for the long-lived `serve` path, which must start even
 * when nothing is configured: a missing credential becomes a backend that
 * answers every call with that same named error, so the harness shows the
 * server connected and the agent is told what to set.
 */
export function createServerBackend(
  name?: string,
  env: Record<string, string | undefined> = process.env,
): ResolvedBackend {
  try {
    return createBackend(name, env);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { backend: new UnconfiguredBackend(reason), via: `unconfigured — ${reason}` };
  }
}
