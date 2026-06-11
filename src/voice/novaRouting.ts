/**
 * src/voice/novaRouting.ts — the PURE provider-selection + AWS-credential resolution for the live
 * voice session. Carved out of server.ts's realLiveConnector so the routing decision (which backend?)
 * and the credential precedence (settings vs env) are unit-testable WITHOUT importing server.ts (which
 * has boot side-effects) and without a live AWS handshake.
 *
 * Both functions are total and side-effect-free: same inputs ⇒ same output.
 */

import type { SystemSettings } from "../types";
import type { NovaAuth } from "./novaSonic";

/** The minimal env slice the auth resolver reads (injected so tests pass a fixture, never process.env). */
export interface NovaEnv {
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_REGION?: string;
  AWS_SESSION_TOKEN?: string;
}

/**
 * Which conversational backend the live voice session should use. DEFAULT "gemini" (absent provider ⇒
 * gemini) so every existing config is unchanged. An explicit provider wins; otherwise the model id is
 * sniffed as a belt-and-suspenders fallback (an "amazon.nova-*" model implies Nova even if the provider
 * field was never set). Read at connect time so an Apply & Reconnect switches backends.
 */
export function resolveVoiceProvider(voiceAi: SystemSettings["voiceAi"] | undefined): "gemini" | "nova" {
  if (voiceAi?.provider === "nova") return "nova";
  if (voiceAi?.provider === "gemini") return "gemini";
  return String(voiceAi?.model ?? "").startsWith("amazon.nova") ? "nova" : "gemini";
}

/** The env-only sentinel: a settings value equal to this means "use the environment variable instead". */
const ENV_SENTINEL = "CONFIGURED_IN_ENV";

/**
 * Resolve the AWS credentials for the Nova connector. Precedence: a real (non-blank, non-sentinel)
 * settings value wins; otherwise fall back to the corresponding AWS_* environment variable; region
 * defaults to us-east-1 (a Nova 2 Sonic region) when neither is set. The STS session token is env-only
 * (temporary creds are not entered through the Settings UI). NEVER logs or throws.
 */
export function resolveNovaAuth(settings: SystemSettings | undefined, env: NovaEnv): NovaAuth {
  const secrets = settings?.secrets;
  const voiceAi = settings?.voiceAi;
  const fromSettings = (v: string | undefined): string | undefined =>
    v && v !== ENV_SENTINEL ? v : undefined;

  const accessKeyId = fromSettings(secrets?.awsAccessKeyId) ?? env.AWS_ACCESS_KEY_ID ?? "";
  const secretAccessKey = fromSettings(secrets?.awsSecretAccessKey) ?? env.AWS_SECRET_ACCESS_KEY ?? "";
  const region = voiceAi?.awsRegion || env.AWS_REGION || "us-east-1";

  return {
    accessKeyId,
    secretAccessKey,
    region,
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
  };
}
