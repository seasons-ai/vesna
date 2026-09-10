import type { Preset } from "./catalog";

/**
 * What you can ask for.
 *
 * For the two services with a fixed roster the list is written down. For
 * anything speaking the OpenAI API it is asked of the endpoint itself — a
 * question to a service already configured and already being talked to, which
 * is a different thing from scanning the machine for servers.
 */
const BUILT_IN: Record<string, string[]> = {
  anthropic: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  codex: ["gpt-5.6-sol"],
  subscription: ["gpt-5.6-sol"],
};

// Not `typeof fetch`: that type carries a required `preconnect` method, which
// a plain test double never has. A narrower call signature is everything a
// caller needs to inject one, and the real `fetch` still satisfies it — this
// one also carries `init`, which the real fetch already accepts, so a header
// can be injected the same way the URL is.
type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export async function listModels(
  preset: Preset,
  baseUrl: string | undefined,
  fetchImpl: FetchImpl = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const known = BUILT_IN[preset.id];
  if (known !== undefined) return known;

  const base = baseUrl ?? preset.baseUrl;
  if (base === undefined) return [preset.model];

  // openai, openrouter and groq have catalogues worth listing, and all three
  // 401 without this — the fallback below would otherwise hide that failure
  // as a quiet, correct-looking one-model answer.
  const key = preset.env !== undefined ? env[preset.env] : undefined;
  const init: RequestInit | undefined =
    key !== undefined && key !== "" ? { headers: { Authorization: `Bearer ${key}` } } : undefined;

  try {
    const response = await fetchImpl(`${base.replace(/\/$/, "")}/models`, init);
    if (!response.ok) return [preset.model];
    const body: any = await response.json();
    const ids = (body?.data ?? [])
      .map((entry: any) => entry?.id)
      .filter((id: unknown): id is string => typeof id === "string" && id !== "");
    // An endpoint that is up but has nothing loaded should not erase the
    // model the user already has configured.
    return ids.length > 0 ? ids.sort() : [preset.model];
  } catch {
    // Not running, wrong address, no network: the preset's own model is still
    // a true answer to "what can I ask for".
    return [preset.model];
  }
}
