import { homedir } from "node:os";
import { join } from "node:path";
import { runLive } from "../loop/loop";
import { createStdioPrompt, isInteractive } from "../tui/stdio";
import { isExpired, loadAuth } from "../auth/store";
import { codexAuthPath, readCodexAuth } from "../auth/codex";
import { inspectCredential, problem, remedy, usable } from "./preflight";
import { writeStarterConfig } from "./init";
import { loadConfig, permits } from "./config";
import { colorDepth, resolveTheme } from "../tui/theme";
import { runChat } from "./chat";
import { runTui } from "../tui/stdin";
import { buildContext, buildProviderFor, CODEX_BASE_URL } from "./context";
import { EXIT } from "./exit";
import { isHelp, isVersion, VERSION } from "./entry";
import { parseFlags } from "./flags";
import { authCommand } from "./authcmd";
import { buildCommand } from "./buildcmd";
import { needsOnboarding, runOnboarding } from "./onboard";
import type { Preset } from "../providers/catalog";

const USAGE = [
  "usage:",
  "  vesna                                   open the chat; sets you up on the first run",
  "  vesna chat [--plain]                    full-screen chat; --plain for a dumb terminal",
  "  vesna do \"<task>\"                       solve one task and print the answer",
  "  vesna init                              pin the current settings to this repository",
  "  vesna auth                              show which model credentials will be used",
  "  vesna auth login                        sign in (browser, headless, or API key)",
  "  vesna build <slug>                      run an approved plan: build, review, merge",
].join("\n");

/**
 * Every first word `route` can hand back.
 *
 * The brief this task follows declared this as `"chat" | "onboard" | "usage"
 * | "error" | string`, which TypeScript collapses to plain `string` — the
 * `| string` in a union with other string literals swallows them all, so it
 * silently drops `"version"` even though the tests below assert it. A named
 * union keeps every value real, `"version"` included.
 */
export type Command = "init" | "chat" | "do" | "auth" | "build";

export type Route = Command | "onboard" | "usage" | "version" | "error";

const COMMANDS = new Set<string>(["init", "chat", "do", "auth", "build"]);

/**
 * What the arguments ask for.
 *
 * Bare `vesna` is the whole point of this: the program should do its job when
 * you run it, and set itself up when it cannot. An unrecognised first word
 * stays an error — reading it as a task would let a mistyped command start
 * work nobody asked for.
 */
export function route(argv: string[], state: { configured: boolean }): Route {
  const [command] = argv;
  // The bare-command case must be settled before `isHelp` gets a look at it:
  // `isHelp(undefined)` is true (that is how a bare `vesna` used to print
  // usage), and that old meaning is exactly what this task replaces.
  if (command === undefined) return state.configured ? "chat" : "onboard";
  if (isHelp(command)) return "usage";
  if (isVersion(command)) return "version";
  if (COMMANDS.has(command)) return command as Command;
  return "error";
}

/**
 * Whether this route has to know which service is configured.
 *
 * `~/.vesna/settings.yaml` is Vesna's own file and an unusable value in it is
 * reported rather than thrown (see `settingsProblem` in src/cli/config.ts), so
 * something has to decide where that report becomes a refusal. The line is
 * "does this command reach a model, or write the answer into a file that
 * outlives it" — `--help` and `--version` do neither, and used to exit 2 all
 * the same.
 *
 * `init` is on the true side because it pins whatever is in effect into the
 * user's own `.vesna/config.yaml`: pinning a fallback nobody chose is the
 * silent-default failure again, written down permanently this time.
 * `onboard` is how a machine file gets rewritten in the first place.
 */
export function needsProvider(route: Route): boolean {
  switch (route) {
    case "chat":
    case "do":
    case "auth":
    case "init":
    case "build":
      return true;
    case "onboard":
    case "usage":
    case "version":
    case "error":
      return false;
  }
}

/**
 * Proves a preset and model actually work by making them answer.
 *
 * This is the entire point of onboarding: it reports success because a model
 * replied, not because a file was written. Nothing here is a stub — a real
 * provider is built and a real (tiny) completion is sent.
 */
async function verifyPreset(
  oauth: { issuer: string; clientId: string; baseUrl: string; scope?: string } | undefined,
  preset: Preset,
  model: string,
  baseUrl?: string,
): Promise<string> {
  const provider = await buildProviderFor(preset, baseUrl, process.env, oauth);
  const result = await provider.complete({
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxTokens: 8,
  });
  return result.model;
}

export async function main(argv: string[]): Promise<number> {
  const [command, target, ...rest] = argv;
  const root = process.cwd();
  const flags = parseFlags(rest);

  // Signing in must not require a working provider, so auth commands are served
  // from config alone, before buildContext tries to construct one.
  let earlyConfig = await loadConfig(root);
  const earlyTheme = resolveTheme(earlyConfig.theme, {
    depth: colorDepth(process.env, Boolean(process.stdout.isTTY)),
  });

  const action = route(argv, { configured: !needsOnboarding(earlyConfig) });

  // Asking for help or the version is a successful request, not a misuse.
  if (action === "usage") {
    console.log(USAGE);
    return EXIT.ok;
  }
  if (action === "version") {
    console.log(VERSION);
    return EXIT.ok;
  }
  if (action === "error") {
    console.error(`vesna: unknown command "${command}"`);
    console.error("");
    console.error(USAGE);
    return EXIT.error;
  }

  // The machine file could not be used. It is Vesna's own file, so this is a
  // refusal for the commands that need a service and nothing at all for the
  // rest — the alternative, throwing out of `loadConfig` above, ran before
  // `route` had even looked at the arguments.
  if (
    earlyConfig.settingsProblem !== undefined &&
    needsProvider(action)
  ) {
    console.error(`vesna: ${earlyConfig.settingsProblem}`);
    return EXIT.error;
  }

  if (action === "auth") return await authCommand(target, earlyConfig, earlyTheme, root);

  if (action === "init") {
    // `init` used to write a guessed-from-the-machine starter. Now that
    // machine-wide settings exist, its job is pinning whatever is already in
    // effect (project file, machine settings, or preset default) to this
    // repository — not guessing a fresh one.
    //
    // The preset's own id is what gets written, not the collapsed
    // `earlyConfig.provider` (just "anthropic" or "openai"): every
    // openai-compatible service — groq, ollama, openrouter, a custom host —
    // shares that one value, so pinning it would silently swap the service
    // in effect for the plain openai default the next time this file loads.
    const path = await writeStarterConfig(root, {
      provider: earlyConfig.preset.id,
      auth: earlyConfig.auth,
      model: earlyConfig.model,
      baseUrl: earlyConfig.baseUrl,
      env: earlyConfig.preset.env,
    });
    console.log(earlyTheme.paint("ok", `Wrote ${path}`));
    console.log(
      earlyTheme.paint(
        "muted",
        `            ${earlyConfig.preset.label} / ${earlyConfig.model}, pinned from the settings currently in effect`,
      ),
    );
    return EXIT.ok;
  }

  // Bare `vesna` with nothing to work with sets itself up first, then
  // continues into the chat in the same process — the whole point of a bare
  // command is that it does the job, not that it tells you to run another one.
  let enteringChat = action === "chat";
  if (action === "onboard") {
    const io = createStdioPrompt();
    let finished: boolean;
    try {
      finished = await runOnboarding({
        io,
        env: process.env,
        home: homedir(),
        config: earlyConfig,
        verify: (preset, model, baseUrl) => verifyPreset(earlyConfig.oauth, preset, model, baseUrl),
      });
    } finally {
      io.close();
    }
    if (!finished) return EXIT.error;
    earlyConfig = await loadConfig(root);
    enteringChat = true;
  }

  // Nothing below can reach a model without a credential, and learning that
  // from an SDK error names a provider the user never chose.
  if (enteringChat || command === "do" || command === "build") {
    const credential = await inspectCredential(earlyConfig, process.env, homedir());
    if (!usable(credential)) {
      console.error(`vesna: ${problem(credential)}`);
      for (const line of remedy(earlyConfig, credential)) console.error(line);
      return EXIT.error;
    }
  }

  const { registry, config, provider, theme, notes, policy, sink } = await buildContext(root);
  const permit = (node: { use: string }) => permits(config, node.use);

  if (enteringChat) {
    const deps = { registry, provider, config, theme, root, notes, policy, sink };
    // The line-based chat stays available for dumb terminals and for piping.
    if (flags.plain !== undefined || !process.stdout.isTTY) return await runChat(deps);
    return await runTui(deps);
  }

  if (command === "do" && target) {
    const started = Date.now();
    const trace = await runLive(target, provider, registry, {
      cwd: root,
      model: flags.model ?? config.model,
      prices: config.prices,
      notes,
      permit: (type) => permits(config, type),
      onStep: (step) =>
        console.log(
          `  ${theme.paint("petal", "·")} ${theme.paint("text", step.nodeType.padEnd(8))} ${theme.paint("muted", `${step.durationMs}ms`)}`,
        ),
    });

    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (trace.finalText) console.log(`\n${trace.finalText}`);
    console.log(`\n${trace.steps.length} steps · ${seconds}s · $${trace.costUsd.toFixed(4)}`);
    return EXIT.ok;
  }

  if (command === "build") {
    return await buildCommand(target, root, { provider, registry, policy, theme, model: flags.model ?? config.model });
  }

  console.error(`vesna: unknown command "${command}"`);
  console.error("");
  console.error(USAGE);
  return EXIT.error;
}
