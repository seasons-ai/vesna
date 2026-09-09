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
import { browserLogin } from "../auth/login";
import { authPath, isExpired, loadAuth, saveAuth } from "../auth/store";
import { codexAuthPath, readCodexAuth } from "../auth/codex";
import { configDir, credentialSource, listProfiles } from "./auth";
import { loadConfig, type VesnaConfig } from "./config";
import { colorSupported, resolveTheme, type Theme } from "../tui/theme";
import { runChat } from "./chat";
import { runTui } from "../tui/stdin";
import { buildContext, CODEX_BASE_URL } from "./context";
import { EXIT } from "./exit";
import { parseFlags } from "./flags";
import { formatParameter } from "./format";
import { describeDropped } from "./dropped";
import { diagnose } from "./doctor";
import { planRun, summarizeFlow } from "./inspect";

const USAGE = [
  "usage:",
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


async function authCommand(
  target: string | undefined,
  config: VesnaConfig,
  theme: Theme,
  root: string,
): Promise<number> {
  if (target === "login") {
    if (config.provider !== "openai" || !config.oauth) {
      console.log("Sign-in applies to the openai provider with an oauth block configured.");
      console.log(theme.paint("muted", "  provider: openai"));
      console.log(theme.paint("muted", "  auth: subscription"));
      console.log(theme.paint("muted", "  oauth: { issuer, clientId, baseUrl }"));
      return EXIT.error;
    }

    const io = createStdioPrompt();
    try {
      console.log(theme.paint("text", "How would you like to sign in?"));
      console.log(`  ${theme.paint("petal", "1")}  browser      opens ${config.oauth.issuer}`);
      console.log(`  ${theme.paint("petal", "2")}  headless     print the URL to open elsewhere`);
      console.log(`  ${theme.paint("petal", "3")}  API key      paste a key instead`);
      const choice = (await io.question("\n  choice [1]: ")).trim() || "1";

      if (choice === "3") {
        const key = (await io.question("  API key: ")).trim();
        if (key === "") {
          console.error("no key entered");
          return EXIT.error;
        }
        const path = authPath(process.env, homedir());
        await saveAuth(path, { provider: "openai", accessToken: key });
        console.log(theme.paint("ok", `\nSaved to ${path}`));
        return EXIT.ok;
      }

      const headless = choice === "2";
      const auth = await browserLogin(
        {
          issuer: config.oauth.issuer,
          clientId: config.oauth.clientId,
          provider: "openai",
          scope: config.oauth.scope,
        },
        {
          async openBrowser(url) {
            if (headless) {
              console.log(theme.paint("muted", "\n  open this on any machine with a browser:\n"));
              console.log(`  ${url}\n`);
              return;
            }
            console.log(theme.paint("muted", "\n  opening your browser…"));
            Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
          },
        },
      );

      const path = authPath(process.env, homedir());
      await saveAuth(path, auth);
      console.log(theme.paint("ok", `\nSigned in. Saved to ${path}`));
      return EXIT.ok;
    } finally {
      io.close();
    }
  }

  {
    console.log(`provider:   ${theme.paint("petal", config.provider)}  model ${config.model}`);

    if (config.provider === "openai" && config.auth === "codex") {
      const path = codexAuthPath(process.env, homedir());
      const auth = await readCodexAuth(path);
      console.log(`endpoint:   ${config.baseUrl ?? CODEX_BASE_URL}`);
      if (auth?.accessToken === undefined) {
        console.log(`credential: ${theme.paint("warn", "no codex subscription token")}`);
        console.log("");
        console.log("  codex login");
        return EXIT.error;
      }
      const expired = auth.expiresAt !== undefined && auth.expiresAt <= Date.now();
      console.log(
        `credential: borrowed from codex  ${
          expired ? theme.paint("warn", "expired — run `codex login`") : theme.paint("ok", "valid")
        }`,
      );
      console.log(theme.paint("muted", `            ${path} (read-only)`));
      return expired ? EXIT.error : EXIT.ok;
    }

    if (config.provider === "openai" && config.auth === "subscription") {
      const path = authPath(process.env, homedir());
      const stored = await loadAuth(path);
      console.log(`endpoint:   ${config.oauth?.baseUrl ?? theme.paint("warn", "not configured")}`);
      if (stored === null) {
        console.log(`credential: ${theme.paint("warn", "not signed in")}`);
        console.log("");
        console.log("  vesna auth login");
        return EXIT.error;
      }
      const state = isExpired(stored, Date.now())
        ? theme.paint("warn", "expired — will refresh on next use")
        : theme.paint("ok", "valid");
      console.log(`credential: subscription token  ${state}`);
      console.log(theme.paint("muted", `            ${path}`));
      return EXIT.ok;
    }

    if (config.provider === "openai") {
      const local = config.baseUrl !== undefined && /localhost|127\.0\.0\.1/.test(config.baseUrl);
      const key = process.env.OPENAI_API_KEY;
      console.log(`endpoint:   ${config.baseUrl ?? "https://api.openai.com/v1"}`);
      if (key) {
        console.log(`credential: ${theme.paint("ok", "OPENAI_API_KEY")}`);
        return EXIT.ok;
      }
      if (local) {
        console.log(
          `credential: ${theme.paint("ok", "none needed")} ${theme.paint("muted", "(local endpoint)")}`,
        );
        return EXIT.ok;
      }
      console.log(`credential: ${theme.paint("warn", "none")}`);
      console.log("");
      console.log("  export OPENAI_API_KEY=...   # or point baseUrl at a local host");
      return EXIT.error;
    }

    const dir = configDir(process.env, process.platform, homedir());
    const profiles = await listProfiles(dir);
    const source = credentialSource(process.env, profiles);

    const label =
      source.kind === "profile"
        ? theme.paint("ok", `OAuth profile "${source.profile}"`)
        : source.kind === "api_key"
          ? theme.paint("ok", "ANTHROPIC_API_KEY")
          : source.kind === "auth_token"
            ? theme.paint("ok", "ANTHROPIC_AUTH_TOKEN")
            : theme.paint("warn", "none");

    console.log(`credential: ${label}`);
    console.log(theme.paint("muted", `            ${source.note}`));
    console.log(theme.paint("muted", `profiles:   ${profiles.length > 0 ? profiles.join(", ") : "none"} (${dir})`));

    if (source.kind === "none" || source.kind === "missing_profile") {
      console.log("");
      console.log("Vesna reads whatever the Anthropic SDK reads. Either:");
      console.log("  export ANTHROPIC_API_KEY=...");
      console.log("  ant auth login          # OAuth, refreshed automatically, no static key");
      return EXIT.error;
    }
    return EXIT.ok;
  }


}

export async function main(argv: string[]): Promise<number> {
  const [command, target, ...rest] = argv;
  const root = process.cwd();
  const flags = parseFlags(rest);
  // Signing in must not require a working provider, so auth commands are served
  // from config alone, before buildContext tries to construct one.
  const earlyConfig = await loadConfig(root);
  const earlyTheme = resolveTheme(earlyConfig.theme, {
    color: colorSupported(process.env, Boolean(process.stdout.isTTY)),
  });
  if (command === "auth") return await authCommand(target, earlyConfig, earlyTheme, root);

  const { registry, store, config, provider, theme } = await buildContext(root);
  const permit = (node: { use: string }) => config.permissions.nodes.includes(node.use);

  if (command === "chat") {
    const deps = { registry, provider, store, config, theme, root };
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
      permit: (type) => config.permissions.nodes.includes(type),
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

  console.log(USAGE);
  return command === undefined ? EXIT.ok : EXIT.error;
}
