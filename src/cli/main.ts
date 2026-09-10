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
import { chooseStarter, writeStarterConfig } from "./init";
import { loadConfig, permits } from "./config";
import { colorDepth, resolveTheme } from "../tui/theme";
import { runChat } from "./chat";
import { runTui } from "../tui/stdin";
import { buildContext, CODEX_BASE_URL } from "./context";
import { EXIT } from "./exit";
import { isHelp, isVersion, VERSION } from "./entry";
import { parseFlags } from "./flags";
import { formatParameter } from "./format";
import { describeDropped } from "./dropped";
import { diagnose } from "./doctor";
import { planRun, summarizeFlow } from "./inspect";
import { authCommand } from "./authcmd";

const USAGE = [
  "usage:",
  "  vesna init                              write a starter .vesna/config.yaml here",
  "  vesna chat [--plain]                    full-screen chat; --plain for a dumb terminal",
  "  vesna do \"<task>\"                       solve a task live and record a trace",
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

async function loadFlowFile(root: string, name: string) {
  return parseFlow(await readFile(join(root, ".vesna", "flows", `${name}.yaml`), "utf8"));
}

export async function main(argv: string[]): Promise<number> {
  const [command, target, ...rest] = argv;
  const root = process.cwd();
  const flags = parseFlags(rest);

  // Asking for help or the version is a successful request, not a misuse.
  if (isHelp(command)) {
    console.log(USAGE);
    return EXIT.ok;
  }
  if (isVersion(command)) {
    console.log(VERSION);
    return EXIT.ok;
  }
  // Signing in must not require a working provider, so auth commands are served
  // from config alone, before buildContext tries to construct one.
  const earlyConfig = await loadConfig(root);
  const earlyTheme = resolveTheme(earlyConfig.theme, {
    depth: colorDepth(process.env, Boolean(process.stdout.isTTY)),
  });
  if (command === "auth") return await authCommand(target, earlyConfig, earlyTheme, root);

  if (command === "init") {
    const starter = await chooseStarter(process.env, homedir());
    const path = await writeStarterConfig(root, starter);
    console.log(earlyTheme.paint("ok", `Wrote ${path}`));
    console.log(
      earlyTheme.paint("muted", `            ${starter.provider} / ${starter.auth}, chosen from what is on this machine`),
    );
    console.log(earlyTheme.paint("muted", "next: vesna auth"));
    return EXIT.ok;
  }

  // Nothing below can reach a model without a credential, and learning that
  // from an SDK error names a provider the user never chose.
  if (command === "chat" || command === "do") {
    const credential = await inspectCredential(earlyConfig, process.env, homedir());
    if (!usable(credential)) {
      console.error(`vesna: ${problem(credential)}`);
      for (const line of remedy(earlyConfig, credential)) console.error(line);
      return EXIT.error;
    }
  }

  const { registry, store, config, provider, theme, notes, policy, sink } = await buildContext(root);
  const permit = (node: { use: string }) => permits(config, node.use);

  if (command === "chat") {
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

    if (flags["dry-run"]) {
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
