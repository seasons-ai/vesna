import { PRESETS, findPreset, needsAddress, needsOauth, type Preset } from "../providers/catalog";
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
  // Everything except the presets this menu cannot finish. `subscription`
  // needs an `oauth` block, and onboarding writes machine settings and never
  // touches a project directory — offering it meant offering a dead end.
  const offered = PRESETS.filter((preset) => !needsOauth(preset));
  for (const preset of offered) {
    const credential =
      preset.env !== undefined && env[preset.env] ? ` — key found in $${preset.env}` : "";
    io.write(`  ${preset.id} — ${preset.label}${credential}`);
  }

  let preset: Preset | undefined;
  while (preset === undefined) {
    const answer = (await io.question("service: ")).trim();
    const chosen = findPreset(answer);
    if (chosen === undefined) {
      io.write(`unknown service "${answer}" — pick one of the ids above`);
    } else if (needsOauth(chosen)) {
      // A real preset, so "unknown" would be a lie. It is set up by hand.
      io.write(
        `${chosen.id} needs an oauth block (issuer, clientId, baseUrl) in .vesna/config.yaml — ` +
          "pick one of the ids above",
      );
    } else {
      preset = chosen;
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
  // routing through the same module: it is equivalent now that
  // `inspectCredential`'s openai-dialect branch reads `preset.env` too (see
  // src/cli/preflight.ts), and duplicating a call already made above for the
  // anthropic case buys nothing here.
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

  // A preset that ships no address of its own — `custom`, "anything else that
  // speaks the OpenAI API" — is unusable until someone gives it one, and the
  // openai dialect's own default is api.openai.com. Choosing `custom` and
  // being asked nothing is how a local-server setup became a silent,
  // unauthenticated conversation with OpenAI.
  let baseUrl: string | undefined;
  while (needsAddress(preset) && baseUrl === undefined) {
    const answer = (await io.question("base URL: ")).trim();
    if (answer !== "") baseUrl = answer;
    else io.write(`${preset.label} needs an address, e.g. http://127.0.0.1:8080/v1`);
  }

  const modelAnswer = (await io.question(`model [${preset.model}]: `)).trim();
  const model = modelAnswer === "" ? preset.model : modelAnswer;

  let answered: string;
  try {
    answered = await verify(preset, model, baseUrl);
  } catch (error) {
    io.write(`could not reach ${preset.label}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  const settings: GlobalSettings = {
    provider: preset.id,
    model: answered,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(preset.env !== undefined ? { env: preset.env } : {}),
  };
  writeSettings(settingsPath(env, home), settings);
  io.write(`verified — ${preset.label} answered as ${answered}`);
  return true;
}
