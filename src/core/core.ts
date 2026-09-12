import { homedir } from "node:os";
import { join } from "node:path";
import {
  approvalQuestion,
  approveOutcome,
  buildBusy,
  buildFailed,
  buildStart,
  cancelElsewhere,
  classifyOutcome,
  describeHeader,
  describeModels,
  describeProviders,
  modelSwitchOutcome,
  quitTimedOut,
  recoverOutcome,
  specSwitchBlocked,
  switchBlocked,
  switchFailed,
  switchOutcome,
} from "../cli/chatcmd";
import { describeEvent } from "../cli/buildcmd";
import { permits, type VesnaConfig } from "../cli/config";
import type { ProviderHandle } from "../cli/context";
import { asPreset, inspectCredential, problem, remedy, usable } from "../cli/preflight";
import { readSettings, settingsPath, writeSettings } from "../cli/settings";
import { carryHistory } from "../loop/carry";
import { createSession, type Session } from "../loop/session";
import { detailOf, type TraceStep } from "../loop/trace";
import { findPreset } from "../providers/catalog";
import { listModels } from "../providers/models";
import type { AgentMessage, Provider } from "../providers/types";
import type { Registry } from "../registry/types";
import { runBuild, type BuildLoopRequest } from "../sdd/loop";
import type { SpecSink } from "../spec/sink";
import {
  listSessions,
  listSessionsSync,
  readSession,
  type OpenSession,
  type SessionEvent,
  type SessionSummary,
} from "../store/sessions";
import { splitPlan } from "../sdd/brief";
import { buildState, pidAlive, readLockPid, type BuildState } from "../sdd/recover";
import { activeStage, type Approvable, type SpecTree } from "../spec/project";
import { createSpec, digestOf, digestOfText, listSpecs, readSpec, readSpecFile, specPaths, specsRoot } from "../spec/store";
import { decide, facetOf, MODES, type Mode, type Policy } from "../policy/decide";
import { rememberAllow, suggestPattern } from "../policy/store";
import { createAsks } from "./asks";
import type { Core, Notification, NoticeLevel, State, TranscriptEntry } from "./types";

/** Everything the agent needs that is not a screen. The TUI's deps extend it. */
export interface CoreDeps {
  registry: Registry;
  provider: Provider;
  config: VesnaConfig;
  root: string;
  /** The project's own instructions, from .vesna/AGENTS.md. */
  notes?: string;
  /** Where this conversation is written down as it happens. */
  record?: OpenSession;
  /** Prior turns, when this run resumed a stored conversation. */
  resumed?: AgentMessage[];
  /** Where conversations are stored, for /history and /resume. */
  sessionsRoot?: string;
  /** Which actions may proceed without asking. */
  policy?: Policy;
  /** Where the plan nodes write. Told which spec is open. */
  sink?: SpecSink;
  /** Where `/provider` writes the machine-wide default. Defaults to the real environment and home. */
  env?: Record<string, string | undefined>;
  home?: string;
  /**
   * Seams for `/build`'s call into `runBuild`, so a test can fake the worker,
   * the reviewer and the merge step without a real git checkout. `git` is
   * included alongside them: `runBuild` issues a few git calls of its own
   * (reading the base branch, diffing a task's branch) even when the worker
   * and reviewer are faked, and those branches only exist for real when the
   * worker actually makes them. Production never sets this — the real
   * functions are `runBuild`'s own defaults.
   */
  buildSeams?: Pick<BuildLoopRequest, "build" | "resume" | "review" | "merge" | "git" | "verify">;
  /**
   * How long `close()` waits for a cancelled build to write `build.stopped`
   * before giving up on it. Ten seconds unless a test shortens it.
   */
  quitCeilingMs?: number;
}

/** What a node asks before it acts, and what the answer may be. */
export type Action = {
  node: string;
  input: Record<string, unknown>;
  cwd: string;
  effect?: "pure" | "write" | "external";
};

/** One line each, so the notice says what the mode actually means. */
const MODE_HELP: Record<Mode, string> = {
  plan: "look and propose; nothing is changed",
  ask: "you are asked before anything changes",
  auto: "changes go ahead, except the irreversible",
};

/**
 * The agent minus the screen. It owns what `runApp` owned: the session and
 * its turns, the policy and its questions, the spec and the approval, the
 * build and its controller, the chat history and the slash commands. A
 * client subscribes and draws; the words are the chat's.
 */
export function createCore(deps: CoreDeps): Core {
  const listeners = new Set<(n: Notification) => void>();
  const emit = (n: Notification): void => {
    for (const listener of listeners) listener(n);
  };
  const asks = createAsks(emit);

  // The newest run of deltas, the way the screen's transcript keeps the last
  // answer: a step or a notice in between starts a new one. It is what the
  // record writes as the turn's answer, streamed or interrupted alike.
  let answer: string | undefined;
  let answerOpen = false;
  const entry = (params: TranscriptEntry): void => {
    if (params.kind === "delta") {
      answer = answerOpen ? `${answer ?? ""}${params.text}` : params.text;
      answerOpen = true;
    } else {
      answerOpen = false;
    }
    emit({ method: "transcript", params });
  };
  const notice = (text: string, level: NoticeLevel = "muted"): void => entry({ kind: "notice", text, level });

  let policy: Policy = deps.policy ?? { mode: "ask", allow: {}, deny: {} };
  let spec: SpecTree | null = null;
  // Null until someone asked for the list; a client that never shows a
  // column never pays for it.
  let chats: SessionSummary[] | null = null;
  // Whether a build is in flight in this process. Not the log's `building`,
  // which a build killed in an earlier process leaves true forever — that
  // one must not trap the person here as well.
  let building = false;
  // The signal for the build in flight: /build cancel and close() both
  // abort it, and the loop's own abort path writes the events. Null
  // whenever `building` is false.
  let buildController: AbortController | null = null;
  let closing = false;
  // The one close, so a second call joins the first wait rather than
  // aborting twice or starting a second one.
  let closed: Promise<void> | null = null;
  let busy = false;
  let turn: AbortController | null = null;
  // One thing at a time, in the order asked: a message or a command that
  // arrives during a turn, or while a question stands, waits its turn — as
  // the chat's own input loop always made it wait. Never rejects: the chain
  // must outlive any one failure. Three commands skip the queue because they
  // need no session and must not wait for one: `chats` is a list refresh
  // for a column opening mid-turn, `mode` changes the policy the running
  // turn's next tool call is judged by — shift-tab has always applied at
  // once — and `build cancel` stops a build that may be what the queue is
  // waiting on: a cancel that waits behind the build it cancels is a deadlock.
  let free: Promise<void> = Promise.resolve();
  /** The last /history listing, so /resume can take a number rather than an id. */
  let listed: SessionSummary[] = [];

  const specs = specsRoot(deps.root);

  function makeSession(resumed?: AgentMessage[]): Session {
    // After a mid-session /model or /provider switch, the handle is what is
    // actually current — deps.config.model is only a snapshot of how the
    // process started. A plain Provider (most tests, and any consumer that
    // never switches) has no `model` field, hence the fallback.
    const model = (deps.provider as ProviderHandle).model ?? deps.config.model;
    return createSession(deps.provider, deps.registry, {
      cwd: deps.root,
      model,
      prices: deps.config.prices,
      notes: deps.notes,

      permit: (type) => permits(deps.config, type),
      approve,
      ...(resumed ? { history: resumed } : {}),
      // A function, not a value: the stage moves between turns as the person
      // approves a spec or a plan, and a session built once must not keep
      // telling the model about the phase it was in at startup.
      phase: () => {
        const tree = spec;
        const slug = deps.sink?.slug;
        if (tree === null || slug === undefined || slug === null) return undefined;
        const paths = specPaths(specs, slug);
        // Whether the design has been written is a fact about the file, not
        // the log; read it here, fresh each turn like the rest.
        const specWritten = readSpecFile(paths.spec) !== null;
        return {
          stage: activeStage(tree, { specWritten }),
          specPath: paths.spec,
          planPath: paths.plan,
          ...(tree.shape !== undefined ? { shape: tree.shape } : {}),
          planApproved: tree.approved.plan,
          ...(tree.lastStop !== undefined ? { lastStop: tree.lastStop } : {}),
        };
      },
    });
  }

  let session = makeSession(deps.resumed);

  /** Never lets a write to disk take the conversation down with it. */
  function remember(event: SessionEvent): void {
    void deps.record?.append(event).catch(() => {});
  }

  /**
   * One turn. The text is quoted back and recorded as given; the model gets
   * it trimmed, as the chat's parser always handed it over. Resolves once the
   * turn has ended and the approval question, if there is one, is up — not
   * once it is answered, or a client awaiting this before answering would
   * wait forever. The next thing asked of the core does wait for the answer.
   */
  function send(text: string): Promise<void> {
    if (closing) return Promise.resolve();
    const run = free.then(() => runSend(text));
    free = run.then((question) => question.answered, () => {});
    return run.then(() => {});
  }

  async function runSend(text: string): Promise<{ answered: Promise<void> }> {
    if (closing) return { answered: Promise.resolve() };
    entry({ kind: "user", text });
    remember({ t: "user", text });

    busy = true;
    const controller = new AbortController();
    turn = controller;
    changed();

    const before = session.messages.length;
    answer = undefined;
    // An interrupted turn is a person taking the keyboard back: the second
    // ctrl-c the hint promises must arm the exit, not answer a question
    // they did not ask for. The question returns after a completed turn.
    let interrupted = false;
    try {
      await runTurn(text.trim(), controller.signal);
    } catch (error) {
      // An abort is the user's own doing, and reads as a warning. A provider
      // that fell over is a failure, and gets the colour that says so.
      const aborted = controller.signal.aborted;
      interrupted = aborted;
      notice(aborted ? "interrupted" : (error as Error).message, aborted ? "warn" : "error");
    } finally {
      turn = null;

      if (answer !== undefined) remember({ t: "answer", raw: answer });
      const added = session.messages.slice(before);
      if (added.length > 0) remember({ t: "messages", added });
      remember({
        t: "usage",
        inputTokens: session.usage.inputTokens,
        outputTokens: session.usage.outputTokens,
        costUsd: session.costUsd,
      });

      // The final tokens while the turn is still on, then the turn's end,
      // then idle: the order a screen shows them in.
      refreshSpec();
      entry({ kind: "turn-end" });
      busy = false;
      changed();
    }
    // Not awaited: the question is up before `askApproval` first yields,
    // and the answer is the client's to give whenever it likes.
    return { answered: interrupted ? Promise.resolve() : askApproval() };
  }

  async function runTurn(text: string, signal: AbortSignal): Promise<void> {
    let streamed = false;
    const result = await session.send(text, {
      signal,
      onText(delta) {
        streamed = true;
        entry({ kind: "delta", text: delta });
      },
      onStep(step) {
        entry({ kind: "step", step });
        refreshSpec();
        const detail = detailOf(step.input);
        remember({
          t: "step",
          nodeType: step.nodeType,
          durationMs: step.durationMs,
          ...(detail ? { detail } : {}),
        });
      },
    });

    // A provider that does not stream never called onText.
    if (!streamed && result.text) entry({ kind: "delta", text: result.text });
  }

  async function showHistory(argument: string): Promise<void> {
    const root = deps.sessionsRoot;
    if (root === undefined) {
      notice("history is not available in this session", "warn");
      return;
    }

    const everywhere = argument.trim() === "all";
    const all = await listSessions(root, everywhere ? {} : { cwd: deps.root });
    // Resuming the conversation you are already having is not a thing.
    listed = all.filter((found) => found.id !== deps.record?.id);
    refreshChats();

    if (listed.length === 0) {
      notice(
        everywhere ? "no conversations yet" : "no conversations from this folder — /history all",
        "muted",
      );
      return;
    }

    notice(everywhere ? "all folders" : deps.root, "muted");
    for (const [index, found] of listed.entries()) {
      const when = found.updatedAt.slice(0, 16).replace("T", " ");
      const cost = found.costUsd > 0 ? `  $${found.costUsd.toFixed(2)}` : "";
      notice(`${String(index + 1).padStart(2)}  ${when}  ${found.title}${cost}`, "muted");
    }
    notice(`/resume <number> to reopen${everywhere ? "" : " · /history all"}`, "muted");
  }

  /**
   * By number from the last listing, or — a click on the conversations
   * column — by the id of a chat the list knows.
   */
  async function resume(argument: string): Promise<void> {
    const wanted = argument.trim();
    const which = Number.parseInt(wanted, 10);
    const target =
      (Number.isNaN(which) ? undefined : listed[which - 1]) ?? chats?.find((found) => found.id === wanted);
    if (target === undefined) {
      notice("/resume <number> from the last /history listing", "warn");
      return;
    }
    await resumeById(target.id);
  }

  async function resumeById(id: string): Promise<void> {
    const root = deps.sessionsRoot;
    if (root === undefined) {
      notice("history is not available in this session", "warn");
      return;
    }

    const stored = await readSession(root, id);
    if (stored === null) {
      notice("that conversation is no longer on disk", "warn");
      return;
    }

    // Rebuilt rather than summarised: the client shows what was said, and the
    // model is seeded with the messages it actually saw.
    entry({ kind: "clear" });
    const messages: AgentMessage[] = [];
    let replayed = 0;
    for (const event of stored.events) {
      if (event.t === "user") entry({ kind: "user", text: event.text });
      else if (event.t === "answer") {
        entry({ kind: "delta", text: event.raw });
        entry({ kind: "turn-end" });
      } else if (event.t === "step") {
        // The record kept the label the screen showed, not the input it came
        // from; the replayed step carries it where `detailOf` will find it.
        replayed += 1;
        const step: TraceStep = {
          id: `replayed-${replayed}`,
          nodeType: event.nodeType,
          input: event.detail !== undefined ? { detail: event.detail } : {},
          output: undefined,
          durationMs: event.durationMs,
        };
        entry({ kind: "step", step });
      } else if (event.t === "messages") messages.push(...event.added);
    }

    session = makeSession(messages);
    notice(`resumed · ${stored.summary.title}`, "ok");
    changed();
  }

  async function providerCommand(argument: string): Promise<void> {
    // The chat is always handed a ProviderHandle (see buildContext in
    // src/cli/context.ts) — the plain Provider in CoreDeps is the interface
    // every other consumer needs, and this is the one place that needs more.
    const handle = deps.provider as ProviderHandle;
    const env = deps.env ?? process.env;
    const wanted = argument.trim();

    if (wanted === "") {
      for (const line of describeProviders(handle.preset.id, env)) notice(line, "muted");
      return;
    }

    const carried = carryHistory(session.messages);
    const outcome = switchOutcome(wanted, {
      pinned: deps.config.pinned,
      dropped: carried.dropped,
      active: handle.preset.id,
    });

    // Named by what may proceed, not by what may not: every branch below this
    // writes `~/.vesna/settings.yaml`, so a refusal added to `switchOutcome`
    // later stops here on its own instead of falling through to the write.
    if (outcome.kind !== "switched" && outcome.kind !== "pinned") {
      notice(outcome.message, "warn");
      return;
    }

    const preset = findPreset(wanted)!;

    // The same verdict `vesna auth`, the check before a conversation and
    // onboarding all use. Without it this command reported success, wrote the
    // machine default, and left the next bare `vesna` exiting 1 on a
    // credential that was never there — a CLI disabled from inside a chat.
    const probe = asPreset(deps.config, preset);
    const credential = await inspectCredential(probe, env, deps.home ?? homedir());
    if (!usable(credential)) {
      const blocked = switchBlocked(preset.id, problem(credential), remedy(probe, credential));
      notice(blocked.message, "warn");
      for (const line of blocked.hints) notice(line, "muted");
      return;
    }

    const path = settingsPath(env, deps.home ?? homedir());
    const settings = {
      provider: preset.id,
      model: preset.model,
      ...(preset.baseUrl !== undefined ? { baseUrl: preset.baseUrl } : {}),
    };

    if (outcome.kind === "pinned") {
      // Only the machine default moves. The running conversation, and the
      // provider serving it, are exactly what this project pins them to.
      writeSettings(path, settings);
      notice(outcome.message, "ok");
      return;
    }

    // Build the replacement before writing anything or touching the session:
    // a host that refuses the connection must leave both exactly as they
    // were, rather than half-applying a switch that never completed.
    try {
      await handle.switch(preset, preset.model, preset.baseUrl);
    } catch (error) {
      notice(switchFailed(preset.id, error as Error), "error");
      return;
    }
    writeSettings(path, settings);
    notice(outcome.message, "ok");
    session = makeSession(carried.messages);
  }

  async function modelCommand(argument: string): Promise<void> {
    // Same reasoning as /provider above: CoreDeps hands out a plain Provider,
    // but the chat always receives the richer handle that can report and
    // switch model.
    const handle = deps.provider as ProviderHandle;
    const wanted = argument.trim();

    if (wanted === "") {
      // The handle's own baseUrl, not deps.config.baseUrl: after a /provider
      // switch the two can differ, and the config snapshot is stale.
      const models = await listModels(handle.preset, handle.baseUrl);
      for (const line of describeModels(models, handle.model)) notice(line, "muted");
      return;
    }

    const carried = carryHistory(session.messages);
    const env = deps.env ?? process.env;
    const path = settingsPath(env, deps.home ?? homedir());
    const machine = readSettings(path);
    const outcome = modelSwitchOutcome(wanted, {
      pinned: deps.config.pinned,
      dropped: carried.dropped,
      // The handle, because the roster above came from the handle: whichever
      // service listed the models is the service the typed name belongs to.
      active: handle.preset.id,
      ...(machine.provider !== undefined ? { machineProvider: machine.provider } : {}),
    });

    // Named by what may proceed, for the same reason /provider is: both
    // branches below write `~/.vesna/settings.yaml`.
    if (outcome.kind !== "switched" && outcome.kind !== "pinned") {
      notice(outcome.message, "warn");
      return;
    }

    if (outcome.kind === "pinned") {
      // Only the machine default's model moves, and only that: its provider is
      // whatever the machine already chose. This project's pin is a fact about
      // this directory, so writing it into the machine default — which is what
      // `provider: handle.preset.id` did here — takes the one setting that was
      // supposed to stay local and makes it global.
      writeSettings(path, { ...machine, model: wanted });
      notice(outcome.message, "ok");
      return;
    }

    // Not pinned: the handle is what is in effect here, so its own service and
    // address are the tuple worth recording alongside the new model.
    const settings = {
      provider: handle.preset.id,
      model: wanted,
      ...(handle.baseUrl !== undefined ? { baseUrl: handle.baseUrl } : {}),
    };

    // Build the replacement before writing anything or touching the session:
    // a host that refuses the connection must leave both exactly as they
    // were, rather than half-applying a switch that never completed.
    try {
      await handle.switch(handle.preset, wanted, handle.baseUrl);
    } catch (error) {
      notice(switchFailed(wanted, error as Error), "error");
      return;
    }
    writeSettings(path, settings);
    notice(outcome.message, "ok");
    // Rebuilt through the same path /provider uses: the dialect never
    // changes here, so carryHistory should never actually drop anything, but
    // the model the new session is seeded with has to come from makeSession
    // reading the handle, not from the stale snapshot in deps.config.
    session = makeSession(carried.messages);
  }

  function openSpec(slug: string): boolean {
    const tree = readSpec(specs, slug);
    if (tree === null) return false;
    spec = tree;
    // The nodes write to whichever spec the user is looking at.
    if (deps.sink !== undefined) deps.sink.slug = slug;
    return true;
  }

  /**
   * The tree is the log reduced, so it is re-read rather than patched. It also
   * picks up a spec the agent opened for itself: planning is what makes the
   * column appear, and the user should not have had to know a command first.
   */
  function refreshSpec(): void {
    const slug = deps.sink?.slug;
    if (slug !== undefined && slug !== null && spec?.id !== slug) {
      const opened = readSpec(specs, slug);
      if (opened !== null) {
        spec = opened;
        notice(`plan: ${opened.title}  (ctrl-g hides it)`, "ok");
        changed();
        return;
      }
    }
    if (spec !== null) spec = readSpec(specs, spec.id) ?? spec;
    changed();
  }

  /**
   * The state comes from the log and the lock together, the way `runBuild`
   * reads it: a log that says building is a live build only while some
   * process holds the lock. No lock, or a lock whose pid is gone, is a
   * build a killed process left behind — dead, and a person's to recover.
   */
  function currentBuildState(): BuildState {
    if (spec === null || deps.sink?.slug == null) return "idle";
    const lock = join(specPaths(specs, deps.sink.slug).dir, "build.lock");
    const pid = readLockPid(lock);
    return buildState(spec, pid !== null && pidAlive(pid));
  }

  /**
   * The sha256 of the text being approved, so the log names what the yes was
   * for and the loop can refuse a plan edited after it. Null when the file is
   * not there — an approval before the text is written carries no digest.
   */
  function approvalDigest(what: Approvable): string | null {
    const slug = deps.sink?.slug;
    if (slug == null) return null;
    const paths = specPaths(specs, slug);
    return digestOf(what === "spec" ? paths.spec : paths.plan);
  }

  /**
   * The one event no tool can emit, written with the digest of what it
   * approves. `/approve` reads the file now; the question passes the digest
   * it took when it was shown, so a yes names the text that was read.
   */
  function writeApproval(what: Approvable, digest: string | null = approvalDigest(what)): void {
    if (deps.sink === undefined) return;
    deps.sink.emit({ t: "approved", what, ...(digest !== null ? { digest } : {}) });
  }

  /**
   * After a turn that leaves a spec or a plan waiting, one question under the
   * answer. The plan's tasks and their checks come first: the checks are
   * what Vesna will run, so they are part of the yes. Only y writes anything;
   * n writes nothing and the question returns after the next turn. A plan
   * that does not split is not asked about — /build says why.
   *
   * Only a typed y or n answers: enter is what a person presses to send
   * `/exit`, and an approval is a durable event that unlocks /build, so the
   * keystroke that writes it has to be the one the question named.
   *
   * The question is up before this returns to its caller's first await, so
   * a `send` that resolves after the turn has already shown it — and never
   * waits for the answer.
   */
  async function askApproval(): Promise<void> {
    if (closing || building) return;
    const slug = deps.sink?.slug;
    if (slug == null) return;
    const paths = specPaths(specs, slug);
    const specText = readSpecFile(paths.spec);
    const planText = readSpecFile(paths.plan);
    const plan = (() => {
      if (planText === null) return null;
      try {
        return splitPlan(planText);
      } catch {
        return null;
      }
    })();
    const question = approvalQuestion(spec, { specWritten: specText !== null, plan });
    if (question === null) return;
    // The digest of the text in hand — the one whose tasks are listed — not
    // of the file at y: an outside edit while the question stands must not
    // be approved by a yes to a different text. The loop compares the
    // digest at /build and refuses a plan.md that no longer matches it.
    const text = question.what === "spec" ? specText : planText;
    const digest = text === null ? null : digestOfText(text);

    const answer = await asks.ask("approval", question.lines, ["y", "n"], true);
    if (answer === "y") {
      writeApproval(question.what, digest);
      refreshSpec();
      notice(approveOutcome(question.what, spec, true).message, "ok");
    } else {
      notice("not yet", "muted");
    }
    entry({ kind: "turn-end" });
  }

  /**
   * Stops this process's own build, or says why it cannot. "running" is the
   * lock's word, and the lock may be another process's — `vesna build` in a
   * second terminal. This chat has nothing to abort then, and must not say
   * it did. Cancel only aborts: the loop's abort path writes task.failed and
   * build.stopped, and `onEvent` prints them as they land.
   */
  function cancelBuild(): void {
    const outcome = recoverOutcome("cancel", spec, building ? "running" : currentBuildState());
    if (outcome.kind !== "cancel") {
      notice(outcome.message, "warn");
    } else if (buildController === null) {
      notice(cancelElsewhere(), "warn");
    } else {
      buildController.abort();
      notice(outcome.message, "ok");
    }
    entry({ kind: "turn-end" });
  }

  /**
   * `/build` and its recoveries. Synchronous up to the launch, so the queue
   * is held only that long: the build runs alongside the conversation, each
   * event a notice and a fresh tree, and the promise handed back is the
   * build's end — resolved at once when nothing was started.
   */
  function buildCommand(argument: string): Promise<void> {
    // The log may have moved under this chat — a build run and killed in
    // another process — and the lock is read fresh below, so the tree it is
    // judged against has to be fresh too.
    refreshSpec();
    // This process's own build comes first, from its own flag: the loop
    // checks the checkout before it takes the lock, so for a moment after a
    // launch the log and the lock still read as dead, and a second `/build
    // resume` inside that moment would launch a second loop — whose losing
    // `.then` would then clear `building` under the winner.
    if (building && buildController !== null) {
      notice(buildBusy(), "warn");
      entry({ kind: "turn-end" });
      return Promise.resolve();
    }
    // A word after /build is one of the three recoveries. Cancel is taken
    // off the queue by `command` before this runs; the union still names
    // it, and it is answered the same way should that ever change.
    let recovery: BuildLoopRequest["recovery"];
    if (argument.trim() !== "") {
      const outcome = recoverOutcome(argument, spec, currentBuildState());
      if (outcome.kind === "refused") {
        notice(outcome.message, "warn");
        entry({ kind: "turn-end" });
        return Promise.resolve();
      }
      if (outcome.kind === "cancel") {
        cancelBuild();
        return Promise.resolve();
      }
      recovery = { action: outcome.action, ...(outcome.task !== undefined ? { task: outcome.task } : {}) };
      notice(outcome.message, "ok");
    } else {
      const start = buildStart(spec, currentBuildState());
      if (start.kind === "refused") {
        notice(start.message, "warn");
        entry({ kind: "turn-end" });
        return Promise.resolve();
      }
      notice(start.message, "ok");
    }
    // `buildStart` only returns "start" once the plan is approved, and a
    // plan can only be approved through /approve, which itself requires a
    // sink — so `deps.sink` is never undefined here. Guarded anyway, the
    // same way /approve guards its own sink-dependent write, rather than
    // trusting that invariant with a bare assertion.
    if (deps.sink === undefined) {
      entry({ kind: "turn-end" });
      return Promise.resolve();
    }
    entry({ kind: "turn-end" });

    building = true;
    const controller = new AbortController();
    buildController = controller;
    changed();
    const ended = (): void => {
      building = false;
      buildController = null;
      refreshSpec();
    };
    return runBuild({
      root: deps.root,
      specsRoot: specs,
      slug: deps.sink.slug!,
      provider: deps.provider,
      registry: deps.registry,
      policy,
      permit: (type) => permits(deps.config, type),
      ...(deps.notes !== undefined ? { notes: deps.notes } : {}),
      ...(recovery !== undefined ? { recovery } : {}),
      signal: controller.signal,
      ...deps.buildSeams,
      onEvent: (event) => {
        // "building" from `build.started` would just repeat the line
        // `buildStart` already printed above; `build.recovered` has no line
        // of its own — the recovery notice above is it.
        if (event.t !== "build.started") {
          const line = describeEvent(event);
          if (line !== null) notice(line, event.t === "build.stopped" ? "warn" : "muted");
        }
        refreshSpec();
      },
    })
      .then((outcome) => {
        // A stop already reached the transcript as its `build.stopped`
        // event above; only a build that never started has no event to
        // carry its reason.
        if (outcome.status === "could-not-start") notice(outcome.reason, "warn");
        ended();
      })
      .catch((error) => {
        // A build can reject rather than resolve: an ordinary git failure
        // deep inside a worker's own commit throws a plain `Error`, which
        // `runBuild` does not catch into a `Stop`. Left unhandled that takes
        // the whole process down mid-conversation — so it lands in the
        // transcript instead, the same way every other fire-and-forget
        // write in this file guards itself.
        notice(buildFailed(error as Error), "error");
        ended();
      });
  }

  /**
   * Cancels a build in flight and waits for the loop to write build.stopped,
   * but not forever: a hung provider call is cancelled by the same signal,
   * so this is sub-second in practice; ten seconds is the ceiling before
   * giving up. The build's promise would die with the process otherwise,
   * leaving the spec's log saying "building" with nothing left to ever say
   * otherwise.
   */
  async function stopBuild(): Promise<void> {
    if (!building || buildController === null) return;
    buildController.abort();
    const deadline = Date.now() + (deps.quitCeilingMs ?? 10_000);
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        if (!building || Date.now() > deadline) return resolve();
        setTimeout(tick, 50);
      };
      tick();
    });
    if (building) {
      notice(quitTimedOut(), "warn");
      entry({ kind: "turn-end" });
    }
  }

  function specCommand(argument: string): void {
    const [verb, ...rest] = argument.trim().split(/\s+/);
    const name = rest.join(" ");

    if (verb === "new") {
      if (name === "") {
        notice("/spec new <name>", "warn");
        return;
      }
      // Creating a spec opens it, which is a switch: see /spec open below.
      if (spec?.building === true) {
        notice(specSwitchBlocked(), "warn");
        return;
      }
      try {
        const made = createSpec(specs, name);
        openSpec(made.slug);
        notice(`spec ${made.slug}`, "ok");
      } catch (error) {
        notice((error as Error).message, "warn");
      }
      return;
    }

    if (verb === "open") {
      // The build keeps writing to the spec it was started on — `runBuild`
      // took the slug by value. What a switch would move is everything
      // else: the garden, `/approve`, `/classify` and the chat's own `plan`
      // tool would all point at the new spec while the build's events kept
      // landing in the old one, and `/build`'s "already running" check,
      // which reads the open spec, would let a second build start.
      if (spec?.building === true) {
        notice(specSwitchBlocked(), "warn");
        return;
      }
      if (!openSpec(name)) {
        notice(`no spec called "${name}" — /spec for the list`, "warn");
        return;
      }
      notice(`spec ${name}`, "ok");
      return;
    }

    const found = listSpecs(specs);
    if (found.length === 0) {
      notice("no specs yet — /spec new <name>", "muted");
      return;
    }
    for (const listed of found) {
      const here = spec?.id === listed.slug;
      notice(`${here ? "* " : "  "}${listed.slug}  ${listed.title}`, here ? "ok" : "muted");
    }
    notice("/spec open <slug>", "muted");
  }

  function refreshChats(): void {
    if (deps.sessionsRoot === undefined) return;
    chats = listSessionsSync(deps.sessionsRoot, { cwd: deps.root });
  }

  /** Changes how much the agent may do without asking. */
  function setMode(mode: Mode): void {
    policy = { ...policy, mode };
    notice(`mode: ${mode}  ${MODE_HELP[mode]}`, "ok");
    changed();
  }

  /**
   * Asks before an action, and remembers the answer when told to.
   *
   * The remembered rule covers the directory or the command rather than the
   * one file: a rule that answers only this exact path asks again on the next
   * file beside it, which teaches the user to stop reading the question.
   */
  async function approve(action: Action): Promise<"allow" | "deny"> {
    // Nobody is left to ask once the chat is closing.
    if (closing) return "deny";
    const verdict = decide(action, policy, deps.root);
    if (verdict === "allow") return "allow";
    if (verdict === "deny") {
      notice(
        policy.mode === "plan"
          ? `${action.node} refused: plan mode changes nothing — shift-tab to leave it`
          : `refused by policy: ${action.node}`,
        "warn",
      );
      return "deny";
    }

    const facet = facetOf(action, deps.root) ?? "";
    const pattern = facet === "" ? "" : suggestPattern(action.node, facet);

    // `a` is offered even with nothing to make a rule from: pressing it must
    // allow the action once and say so, never leave the question standing.
    const answer = await asks.ask(
      "permission",
      [
        `${action.node}  ${facet}`,
        pattern === ""
          ? "[y] allow   [n] refuse"
          : `[y] allow once   [a] always ${pattern}   [n] refuse`,
      ],
      ["y", "a", "n"],
      false,
    );

    if (answer === "a" && pattern === "") {
      notice("allowed once — there is nothing here to make a rule from", "ok");
      return "allow";
    }

    if (answer === "a") {
      policy = {
        ...policy,
        allow: { ...policy.allow, [action.node]: [...(policy.allow[action.node] ?? []), pattern] },
      };
      void rememberAllow(deps.root, action.node, pattern).catch(() => {});
      notice(`allowed, and remembered: ${pattern}`, "ok");
      return "allow";
    }
    if (answer === "y") {
      notice("allowed once", "ok");
      return "allow";
    }

    notice("refused", "warn");
    return "deny";
  }

  /**
   * Quoted back exactly as typed, so a second client sees the question as
   * well as the answer. A command that came from a key — shift-tab, a click
   * on a conversation — was never typed, and nothing is quoted.
   */
  function quote(typed: string | undefined): void {
    if (typed !== undefined) entry({ kind: "user", text: typed });
  }

  function command(name: string, argument: string, options: { typed?: string } = {}): Promise<void> {
    if (closing) return Promise.resolve();
    // The two that skip the queue — see `free` above.
    if (name === "chats") {
      // The list, not a column: whether it is shown is the client's.
      refreshChats();
      changed();
      return Promise.resolve();
    }
    if (name === "mode") {
      quote(options.typed);
      const wanted = argument.trim();
      if ((MODES as readonly string[]).includes(wanted)) setMode(wanted as Mode);
      else notice(`/mode plan, ask or auto — not "${wanted}"`, "warn");
      entry({ kind: "turn-end" });
      return Promise.resolve();
    }
    if (name === "build" && argument.trim().split(/\s+/)[0] === "cancel") {
      quote(options.typed);
      cancelBuild();
      return Promise.resolve();
    }
    if (name === "build") {
      // The queue is held through the launch only — the build runs alongside
      // the conversation — while the promise handed back spans the build.
      const launched = free.then(() => ({ finished: startBuild(argument, options.typed) }));
      free = launched.then(() => {}, () => {});
      return launched.then((launch) => launch.finished);
    }
    const run = free.then(() => runCommand(name, argument, options.typed));
    free = run.then(() => {}, () => {});
    return run;
  }

  function startBuild(argument: string, typed: string | undefined): Promise<void> {
    if (closing) return Promise.resolve();
    quote(typed);
    return buildCommand(argument);
  }

  async function runCommand(name: string, argument: string, typed: string | undefined): Promise<void> {
    if (closing) return;
    quote(typed);

    if (name === "spec") {
      specCommand(argument);
      entry({ kind: "turn-end" });
      changed();
      return;
    }

    if (name === "approve") {
      const outcome = approveOutcome(argument, spec, deps.sink !== undefined);
      if (outcome.kind === "approved" && deps.sink !== undefined) {
        writeApproval(outcome.what);
        refreshSpec();
        notice(outcome.message, "ok");
      } else {
        notice(outcome.message, "warn");
      }
      entry({ kind: "turn-end" });
      return;
    }

    if (name === "classify") {
      const outcome = classifyOutcome(argument, spec, deps.sink !== undefined);
      if (outcome.kind === "classified" && deps.sink !== undefined) {
        deps.sink.emit({ t: "classified", shape: outcome.shape, by: "person" });
        refreshSpec();
        notice(outcome.message, "ok");
      } else {
        notice(outcome.message, "warn");
      }
      entry({ kind: "turn-end" });
      return;
    }

    if (name === "history") {
      await showHistory(argument);
      entry({ kind: "turn-end" });
      changed();
      return;
    }

    if (name === "resume") {
      await resume(argument);
      entry({ kind: "turn-end" });
      return;
    }

    if (name === "clear") {
      entry({ kind: "clear" });
      notice("new conversation", "muted");
      session = makeSession();
      entry({ kind: "turn-end" });
      changed();
      return;
    }

    if (name === "provider" || name === "model") {
      const modelBefore = (deps.provider as Partial<ProviderHandle>).model;
      if (name === "provider") await providerCommand(argument);
      else await modelCommand(argument);
      // The stored conversation records which model answered it, and that
      // was the startup one for the whole file after a mid-session switch.
      const modelAfter = (deps.provider as Partial<ProviderHandle>).model;
      if (modelAfter !== undefined && modelAfter !== modelBefore) remember({ t: "model", model: modelAfter });
      entry({ kind: "turn-end" });
      changed();
      return;
    }

    notice(`unknown command /${name} - try /help`, "warn");
    entry({ kind: "turn-end" });
  }

  function snapshot(): State {
    // The live handle, not deps.config: the config is how the process started,
    // and `/provider` and `/model` move the connection out from under it. A
    // plain Provider (most tests, and any consumer that never switches) carries
    // neither field, hence the fallbacks.
    const handle = deps.provider as Partial<ProviderHandle>;
    const { model, service } = describeHeader(
      handle.model ?? deps.config.model,
      handle.preset ?? deps.config.preset,
    );
    return {
      mode: policy.mode,
      busy,
      building,
      buildState: building ? "running" : currentBuildState(),
      model,
      service,
      usage: {
        inputTokens: session.usage.inputTokens,
        outputTokens: session.usage.outputTokens,
        costUsd: session.costUsd,
      },
      spec,
      specSlug: spec?.id ?? null,
      chats,
    };
  }

  /** Every change to a fact a client paints ends here: the whole state, again. */
  function changed(): void {
    emit({ method: "state", params: snapshot() });
  }

  return {
    on(listener: (n: Notification) => void): () => void {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    answer: (id: string, value: string): boolean => (closing ? false : asks.answer(id, value)),
    send,
    command,
    interrupt(): void {
      turn?.abort();
    },
    snapshot,
    // As leaving the chat: every open question is answered no, a turn in
    // flight is cut short, nothing asked afterwards does anything, and a
    // build in flight is cancelled and waited for — up to the ceiling.
    close(): Promise<void> {
      if (closed !== null) return closed;
      closing = true;
      for (const ask of asks.open()) asks.answer(ask.id, "n");
      turn?.abort();
      closed = stopBuild();
      return closed;
    },
  };
}

export type { Core, Notification, State } from "./types";
