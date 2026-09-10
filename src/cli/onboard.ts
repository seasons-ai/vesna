import { PRESETS, findPreset, type Preset } from "../providers/catalog";
import type { PromptIO } from "../tui/prompt";
import { settingsPath, writeSettings, type GlobalSettings } from "./settings";
import type { VesnaConfig } from "./config";

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
  /** Injected so tests can assert it was called without reaching the network. Returns the model that answered. */
  verify(preset: Preset, model: string, baseUrl?: string): Promise<string>;
}

/**
 * Picks a service, asks for a model, and proves the pair actually works
 * before writing anything. Returns whether onboarding finished.
 */
export async function runOnboarding(options: OnboardOptions): Promise<boolean> {
  const { io, env, home, verify } = options;

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

  // A call known in advance to fail is not a proof of anything. Asking for a
  // key we cannot get is not this task's job — writing one to disk is not
  // ours to invent — so the honest move is to say what is missing and stop
  // before spending the user's time on a model question too.
  if (preset.env !== undefined && !env[preset.env]) {
    const alsoLogin =
      preset.id === "anthropic" || preset.auth === "subscription" || preset.auth === "codex"
        ? " — or run `vesna auth login`"
        : "";
    io.write(`${preset.label} needs a key: set $${preset.env} and run this again${alsoLogin}`);
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
