import { DEFAULT_MODEL } from "./types";

/**
 * Services, not wire formats.
 *
 * `provider: openai` used to name a dialect, which meant connecting a local
 * server required knowing that the openai provider accepts a baseUrl at all.
 * OpenRouter, Groq, Ollama, LM Studio and vLLM are all that same dialect with
 * a different address, key variable and default model — so they are data.
 *
 * Adding a service is an entry here. It is not a code change.
 */
export type Dialect = "anthropic" | "openai" | "responses";

/** The subscription endpoint the Codex CLI talks to. */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export interface Preset {
  id: string;
  label: string;
  dialect: Dialect;
  model: string;
  baseUrl?: string;
  /** Name of the environment variable holding the key, when one is needed. */
  env?: string;
  /** How the credential is obtained. Absent means a plain key. */
  auth?: "key" | "subscription" | "codex";
}

export const PRESETS: readonly Preset[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    dialect: "anthropic",
    model: DEFAULT_MODEL,
    env: "ANTHROPIC_API_KEY",
  },
  {
    id: "openai",
    label: "OpenAI",
    dialect: "openai",
    model: "gpt-5.6",
    baseUrl: "https://api.openai.com/v1",
    env: "OPENAI_API_KEY",
  },
  {
    id: "codex",
    label: "ChatGPT subscription, borrowed from the Codex CLI",
    dialect: "responses",
    model: "gpt-5.6-sol",
    baseUrl: CODEX_BASE_URL,
    auth: "codex",
  },
  {
    id: "subscription",
    label: "ChatGPT subscription, Vesna's own sign-in",
    dialect: "responses",
    model: "gpt-5.6-sol",
    auth: "subscription",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    dialect: "openai",
    model: "anthropic/claude-sonnet-5",
    baseUrl: "https://openrouter.ai/api/v1",
    env: "OPENROUTER_API_KEY",
  },
  {
    id: "groq",
    label: "Groq",
    dialect: "openai",
    model: "llama-3.3-70b-versatile",
    baseUrl: "https://api.groq.com/openai/v1",
    env: "GROQ_API_KEY",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    dialect: "openai",
    model: "llama3.2",
    baseUrl: "http://127.0.0.1:11434/v1",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    dialect: "openai",
    model: "local-model",
    baseUrl: "http://127.0.0.1:1234/v1",
  },
  {
    id: "vllm",
    label: "vLLM (local)",
    dialect: "openai",
    model: "local-model",
    baseUrl: "http://127.0.0.1:8000/v1",
  },
  {
    id: "custom",
    label: "Anything else that speaks the OpenAI API",
    dialect: "openai",
    model: "local-model",
  },
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((preset) => preset.id === id);
}

/**
 * What an older config means.
 *
 * Before the catalog, `provider` was a dialect and `auth` said how to get a
 * credential for it. Those pairs still name exactly one service each, so they
 * are translated rather than rejected: a config someone wrote last month is
 * not a mistake.
 */
export function presetFor(provider: string, auth: string | undefined): Preset | undefined {
  const named = findPreset(provider);
  if (named !== undefined && named.id !== "openai" && named.id !== "anthropic") return named;

  if (provider === "openai") {
    if (auth === "codex") return findPreset("codex");
    if (auth === "subscription") return findPreset("subscription");
    return findPreset("openai");
  }
  return named;
}
