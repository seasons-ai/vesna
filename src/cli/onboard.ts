import { PRESETS, findPreset, type Preset } from "../providers/catalog";
import type { PromptIO } from "../tui/prompt";
import { settingsPath, writeSettings, type GlobalSettings } from "./settings";
import type { VesnaConfig } from "./config";
import { inspectCredential, problem, remedy, usable } from "./preflight";

/**
 * The first five minutes.
 *
 * It ends with a real call, not with a written file. This codebase already
 * refuses to take a claim for a fact — task_verify will not mark a task done
 * on the agent's word, it runs a command and reads the exit status — and an
 * onboarding that announces success without ever reaching a model is the same
 * lie told to the user instead of by the agent.
 *
 * Nothing is written until the call succeeds. A settings file pointing at an
 * endpoint that never answered is worse than no settings file: it turns the
 * next run into a puzzle rather than a fresh start.
 */

/** Nothing to work with yet — no project config, no machine settings. */
export function needsOnboarding(config: VesnaConfig): boolean {
  return !config.configured;
}

export interface OnboardOptions {
  io: PromptIO;
  env: Record<string, string | undefined>;
  home: string;
  /**
   * The config already loaded for this run. Its `configured` field is the one
   * `remedy()` reads below — onboarding always runs in the one situation where
   * that field is false, so a hand-built stand-in that hardcodes it true would
   * silently drop the "there is no .vesna/config.yaml here" line every time.
   */
  config: VesnaConfig;
  /** Injected so tests can assert it was called without reaching the network. Returns the model that answered. */
  verify(preset: Preset, model: string, baseUrl?: string): Promise<string>;
}

/**
 * Picks a service, asks for a model, and proves the pair actually works
 * before writing anything. Returns whether onboarding finished.
 */
export async function runOnboarding(options: OnboardOptions): Promise<boolean> {
  const { io, env, home, config, verify } = options;

  io.write("Which service should Vesna talk to?");
  for (const preset of PRESETS) {
    const credential =
      preset.env !== undefined && env[preset.env] ? ` — key found in $${preset.env}` : "";
    io.write(`  ${preset.id} — ${preset.label}${credential}`);
  }

  let preset: Preset | undefined;
  while (preset === undefined) {
    const answer = (await io.question("service: ")).trim();
    preset = findPreset(answer);
    if (preset === undefined) {
      io.write(`unknown service "${answer}" — pick one of the ids above`);
    }
  }

  // A call known in advance to fail is not a proof of anything.
  //
  // For anthropic, whether a credential exists is not this module's question
  // to answer a second time: a working setup can be a plain key, an OAuth
  // profile on disk, or ANTHROPIC_AUTH_TOKEN, and src/cli/preflight.ts already
  // resolves all three the same way `vesna auth` and the real preflight check
  // do. Asking `env["ANTHROPIC_API_KEY"]` directly, as this used to, refused a
  // perfectly working profile-authenticated user because it only ever checked
  // one of the three sources.
  //
  // The other presets stay on the plain `preset.env` check below rather than
  // routing through the same module: `inspectCredential`'s openai-dialect
  // branch only ever reads `OPENAI_API_KEY`, because `VesnaConfig.provider`
  // collapses every openai-compatible vendor (openai, groq, openrouter, a
  // custom host) into one `"openai"` value — it has no way to see that this
  // preset's key lives in `GROQ_API_KEY`. Routing groq or openrouter through
  // it here would make onboarding refuse a working groq setup whenever
  // `OPENAI_API_KEY` happens to be unset, which is the exact bug this task
  // already fixed once in `buildProviderFor`. That gap in preflight.ts is
  // pre-existing and reaches beyond onboarding (`vesna chat`/`do` share it
  // too), so it is not fixed here.
  if (preset.dialect === "anthropic") {
    const preflightConfig: VesnaConfig = {
      configured: config.configured,
      preset,
      pinned: false,
      provider: "anthropic",
      auth: "key",
      model: preset.model,
      theme: "vesna",
      prices: {},
      permissions: {},
    };
    const credential = await inspectCredential(preflightConfig, env, home);
    if (!usable(credential)) {
      io.write(problem(credential));
      for (const line of remedy(preflightConfig, credential)) io.write(line);
      return false;
    }
  } else if (preset.env !== undefined && !env[preset.env]) {
    io.write(`${preset.label} needs a key: set $${preset.env} and run this again`);
    return false;
  }

  const modelAnswer = (await io.question(`model [${preset.model}]: `)).trim();
  const model = modelAnswer === "" ? preset.model : modelAnswer;

  let answered: string;
  try {
    answered = await verify(preset, model);
  } catch (error) {
    io.write(`could not reach ${preset.label}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  const settings: GlobalSettings = {
    provider: preset.id,
    model: answered,
    ...(preset.env !== undefined ? { env: preset.env } : {}),
  };
  writeSettings(settingsPath(env, home), settings);
  io.write(`verified — ${preset.label} answered as ${answered}`);
  return true;
}
