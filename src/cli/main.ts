import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { applyParameters } from "../crystallize/apply";
import { proposeFlow, type ProposedParameter } from "../crystallize/propose";
import { parseCsv } from "../engine/csv";
import { runMapped } from "../engine/fanout";
import { healRun } from "../engine/heal";
import { parseFlow } from "../flow/parse";
import { runLive } from "../loop/loop";
import { confirmParameters } from "../tui/prompt";
import { progressBar } from "../tui/render";
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
import { isFlagSet, parseFlags } from "./flags";
import { formatParameter } from "./format";
import { describeDropped } from "./dropped";
import { diagnose } from "./doctor";
import { planRun, summarizeFlow } from "./inspect";
import { authCommand } from "./authcmd";
import { needsOnboarding, runOnboarding } from "./onboard";
import type { Preset } from "../providers/catalog";

const USAGE = [
  "usage:",
  "  vesna                                   open the chat; sets you up on the first run",
  "  vesna chat [--plain]                    full-screen chat; --plain for a dumb terminal",
  "  vesna do \"<task>\"                       solve a task live and record a trace",
  "  vesna init                              pin the current settings to this repository",
  "  vesna run <flow> [--map rows.csv] [--<input> <value>]",
  "  vesna heal <run-id> --flow <flow>",
  "  vesna crystallize <trace-id|file> --name <flow>",
  "  vesna flows                             list crystallised flows",
  "  vesna traces                            list recorded live traces",
  "  vesna auth                              show which model credentials will be used",
  "  vesna auth login                        sign in (browser, headless, or API key)",
  "  vesna doctor",
  "",
  "  --dry-run on `run` validates and prints the plan without executing",
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
export type Command =
  | "init"
  | "chat"
  | "do"
  | "run"
  | "heal"
  | "crystallize"
  | "flows"
  | "traces"
  | "auth"
  | "doctor";

export type Route = Command | "onboard" | "usage" | "version" | "error";

const COMMANDS = new Set<string>([
  "init",
  "chat",
  "do",
  "run",
  "heal",
  "crystallize",
  "flows",
  "traces",
  "auth",
  "doctor",
]);

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
 * outlives it" — `--help`, `--version`, `doctor`, `flows`, `traces` and
 * `run --dry-run` do neither, and used to exit 2 all the same.
 *
 * `init` is on the true side because it pins whatever is in effect into the
 * user's own `.vesna/config.yaml`: pinning a fallback nobody chose is the
 * silent-default failure again, written down permanently this time.
 * `crystallize` reads a trace and writes a flow without ever asking for a
 * service, and `onboard` is how a machine file gets rewritten in the first
 * place.
 */
export function needsProvider(route: Route, flags: { dryRun: boolean }): boolean {
  switch (route) {
    case "chat":
    case "do":
    case "auth":
    case "init":
    case "heal":
      return true;
    case "run":
      return !flags.dryRun;
    case "onboard":
    case "crystallize":
    case "flows":
    case "traces":
    case "doctor":
    case "usage":
    case "version":
    case "error":
      return false;
  }
}

async function loadFlowFile(root: string, name: string) {
  return parseFlow(await readFile(join(root, ".vesna", "flows", `${name}.yaml`), "utf8"));
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
    needsProvider(action, { dryRun: isFlagSet(flags, "dry-run") })
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
  if (enteringChat || command === "do") {
    const credential = await inspectCredential(earlyConfig, process.env, homedir());
    if (!usable(credential)) {
      console.error(`vesna: ${problem(credential)}`);
      for (const line of remedy(earlyConfig, credential)) console.error(line);
      return EXIT.error;
    }
  }

  const { registry, store, config, provider, theme, notes, policy, sink } = await buildContext(root);
  const permit = (node: { use: string }) => permits(config, node.use);

  if (enteringChat) {
    const deps = { registry, provider, store, config, theme, root, notes, policy, sink };
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

    const id = await store.saveLiveTrace(trace);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (trace.finalText) console.log(`\n${trace.finalText}`);
    console.log(
      `\n${trace.steps.length} steps · ${seconds}s · $${trace.costUsd.toFixed(4)} · trace ${id}`,
    );
    console.log(`\nnext: vesna crystallize ${id} --name <flow>`);
    return EXIT.ok;
  }

  if (command === "run" && target) {
    const flow = await loadFlowFile(root, target);
    const rows = flags.map
      ? parseCsv(await readFile(join(root, flags.map), "utf8"))
      : [
          Object.fromEntries(
            Object.entries(flags).filter(([key]) => key !== "map" && key !== "dry-run"),
          ),
        ];

    if (isFlagSet(flags, "dry-run")) {
      const plan = planRun(flow, registry, rows[0] ?? {});
      console.log(`${flow.name}  ${rows.length} row${rows.length === 1 ? "" : "s"}`);
      console.log(`  order:    ${plan.order.join(" -> ")}`);
      console.log(`  external: ${plan.external.length > 0 ? plan.external.join(", ") : "none"}`);
      console.log(`  model:    ${plan.model.length > 0 ? plan.model.join(", ") : "none"}`);
      if (plan.external.length > 0) {
        console.log(
          `\n  ${plan.external.length * rows.length} external effect(s) would happen across ${rows.length} row(s).`,
        );
      }
      return EXIT.ok;
    }

    const summary = await runMapped(flow, registry, rows, {
      store,
      permit,
      cwd: root,
      retries: 1,
      onRow: (row, done, total) => {
        if (total <= 1) return;
        const mark =
          row.result.status === "ok"
            ? theme.paint("ok", "ok  ")
            : theme.paint("warn", "held");
        const bar = theme.paint("petal", progressBar(done, total, 20));
        console.log(`  ${bar} ${done}/${total}  ${mark} row ${row.index}`);
      },
    });
    console.log(`${summary.runId}: ${summary.ok} ok · ${summary.held} held`);
    for (const row of summary.rows.filter((r) => r.result.status === "held")) {
      const failed = row.result.nodes.find((n) => n.status === "held");
      console.log(`  row ${row.index} held at ${failed?.id}: ${failed?.error?.message ?? ""}`);
    }
    return summary.held > 0 ? EXIT.held : EXIT.ok;
  }

  if (command === "heal" && target) {
    if (!flags.flow) {
      console.error("heal requires --flow <flow>");
      return EXIT.error;
    }
    const flow = await loadFlowFile(root, flags.flow);
    const record = await store.readRun(target);
    const summary = await healRun(flow, registry, record, { store, permit, cwd: root });
    console.log(`${summary.runId}: ${summary.ok} ok · ${summary.held} held`);
    return summary.held > 0 ? EXIT.held : EXIT.ok;
  }

  if (command === "crystallize" && target) {
    // Accept either a trace id recorded by `vesna do` or a path to a JSON file.
    const trace = target.endsWith(".json")
      ? JSON.parse(await readFile(target, "utf8"))
      : await store.readLiveTrace(target);
    const proposal = proposeFlow(trace, flags.name ?? "flow");

    const interactive = isInteractive() && flags.yes === undefined;
    const io = interactive ? createStdioPrompt() : null;

    let accepted: Map<string, string>;
    try {
      accepted = await confirmParameters(
        proposal.parameters,
        io ?? { write: (text) => console.log(text), async question() { return ""; } },
        theme,
        { interactive },
      );
    } finally {
      io?.close();
    }

    if (!interactive && proposal.parameters.length > 0) {
      console.log("Applied every proposed parameter (non-interactive):");
      for (const parameter of proposal.parameters) {
        console.log(`  ${formatParameter(parameter)}`);
      }
    }

    const flow = applyParameters(proposal.flow, proposal.parameters, accepted);

    await mkdir(join(root, ".vesna", "flows"), { recursive: true });
    const path = join(root, ".vesna", "flows", `${flow.name}.yaml`);
    await writeFile(path, toYaml(flow));
    for (const line of describeDropped(proposal.dropped, theme)) console.log(line);
    console.log(theme.paint("ok", `Wrote ${path}`));
    console.log(theme.paint("muted", `next: vesna run ${flow.name} --dry-run`));
    return EXIT.ok;
  }

  if (command === "flows") {
    let files: string[];
    try {
      files = (await readdir(join(root, ".vesna", "flows"))).filter((f) => f.endsWith(".yaml"));
    } catch {
      files = [];
    }
    if (files.length === 0) {
      console.log("no flows yet — `vesna do \"<task>\"` then `vesna crystallize <id>`");
      return EXIT.ok;
    }
    for (const file of files.sort()) {
      const flow = parseFlow(await readFile(join(root, ".vesna", "flows", file), "utf8"));
      const summary = summarizeFlow(flow);
      const inputs = summary.inputs
        .map((input) => (input.required ? input.name : `${input.name}?`))
        .join(", ");
      console.log(`${summary.name}  (${summary.nodes.length} nodes)  inputs: ${inputs || "none"}`);
    }
    return EXIT.ok;
  }

  if (command === "traces") {
    const ids = await store.listLiveTraces();
    if (ids.length === 0) {
      console.log("no live traces yet — run `vesna do \"<task>\"`");
      return EXIT.ok;
    }
    for (const id of ids) {
      const trace = await store.readLiveTrace(id);
      const prompt = trace.prompt.length > 56 ? `${trace.prompt.slice(0, 53)}...` : trace.prompt;
      console.log(
        `${id}  ${String(trace.steps.length).padStart(2)} steps  $${trace.costUsd.toFixed(4)}  ${prompt}`,
      );
    }
    return EXIT.ok;
  }

  if (command === "doctor") {
    const runIds = await store.listRuns();
    const records = await Promise.all(runIds.map((id) => store.readRun(id)));
    const health = diagnose(records);
    if (health.length === 0) {
      console.log("no runs recorded yet");
      return EXIT.ok;
    }
    const width = Math.max(...health.map((node) => node.nodeId.length));
    for (const node of health) {
      const rate = `${(node.assertionPassRate * 100).toFixed(0)}%`.padStart(4);
      const cost = node.avgCostUsd.toFixed(4);
      console.log(
        `${node.nodeId.padEnd(width)}  runs ${node.runs}  asserts ${rate}  $${cost}/run`,
      );
    }
    return EXIT.ok;
  }

  console.error(`vesna: unknown command "${command}"`);
  console.error("");
  console.error(USAGE);
  return EXIT.error;
}
