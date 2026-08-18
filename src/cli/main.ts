import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { proposeFlow } from "../crystallize/propose";
import { parseCsv } from "../engine/csv";
import { runMapped } from "../engine/fanout";
import { healRun } from "../engine/heal";
import { parseFlow } from "../flow/parse";
import { buildContext } from "./context";
import { diagnose } from "./doctor";

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = args[i + 1] ?? "true";
      i += 1;
    }
  }
  return flags;
}

const USAGE = [
  "usage:",
  "  vesna run <flow> [--map rows.csv] [--<input> <value>]",
  "  vesna heal <run-id> --flow <flow>",
  "  vesna crystallize <trace.json> --name <flow>",
  "  vesna doctor",
].join("\n");

async function loadFlowFile(root: string, name: string) {
  return parseFlow(await readFile(join(root, ".agent", "flows", `${name}.yaml`), "utf8"));
}

export async function main(argv: string[]): Promise<void> {
  const [command, target, ...rest] = argv;
  const root = process.cwd();
  const flags = parseFlags(rest);
  const { registry, store, config } = await buildContext(root);
  const permit = (node: { use: string }) => config.permissions.nodes.includes(node.use);

  if (command === "run" && target) {
    const flow = await loadFlowFile(root, target);
    const rows = flags.map
      ? parseCsv(await readFile(join(root, flags.map), "utf8"))
      : [Object.fromEntries(Object.entries(flags).filter(([key]) => key !== "map"))];

    const summary = await runMapped(flow, registry, rows, {
      store,
      permit,
      cwd: root,
      retries: 1,
    });
    console.log(`${summary.runId}: ${summary.ok} ok · ${summary.held} held`);
    for (const row of summary.rows.filter((r) => r.result.status === "held")) {
      const failed = row.result.nodes.find((n) => n.status === "held");
      console.log(`  row ${row.index} held at ${failed?.id}: ${failed?.error?.message ?? ""}`);
    }
    return;
  }

  if (command === "heal" && target) {
    if (!flags.flow) {
      console.log("heal requires --flow <flow>");
      return;
    }
    const flow = await loadFlowFile(root, flags.flow);
    const record = await store.readRun(target);
    const summary = await healRun(flow, registry, record, { store, permit, cwd: root });
    console.log(`${summary.runId}: ${summary.ok} ok · ${summary.held} held`);
    return;
  }

  if (command === "crystallize" && target) {
    const trace = JSON.parse(await readFile(target, "utf8"));
    const proposal = proposeFlow(trace, flags.name ?? "flow");

    console.log("Proposed parameters — confirm before applying:");
    if (proposal.parameters.length === 0) {
      console.log("  (none found)");
    }
    for (const parameter of proposal.parameters) {
      const sites = parameter.sites.map((s) => `${s.nodeId}.${s.field}`).join(", ");
      console.log(`  "${parameter.literal}"  ->  \${{inputs.${parameter.suggestedName}}}   at ${sites}`);
    }

    await mkdir(join(root, ".agent", "flows"), { recursive: true });
    const path = join(root, ".agent", "flows", `${proposal.flow.name}.yaml`);
    await writeFile(path, toYaml(proposal.flow));
    console.log(`Wrote ${path}`);
    return;
  }

  if (command === "doctor") {
    const runIds = await store.listRuns();
    const records = await Promise.all(runIds.map((id) => store.readRun(id)));
    const health = diagnose(records);
    if (health.length === 0) {
      console.log("no runs recorded yet");
      return;
    }
    for (const node of health) {
      const rate = (node.assertionPassRate * 100).toFixed(0);
      const cost = node.avgCostUsd.toFixed(4);
      console.log(`${node.nodeId}  runs ${node.runs}  asserts ${rate}%  $${cost}/run`);
    }
    return;
  }

  console.log(USAGE);
}
