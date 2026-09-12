import { homedir } from "node:os";
import { join } from "node:path";
import {
  CHAT_COMMANDS,
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
  hintLine,
  modeRole,
  modelSwitchOutcome,
  nextMode,
  parseChatInput,
  quitCancelling,
  quitTimedOut,
  recoverOutcome,
  specSwitchBlocked,
  switchBlocked,
  switchFailed,
  switchOutcome,
} from "../cli/chatcmd";
import { describeEvent } from "../cli/buildcmd";
import { EXIT } from "../cli/exit";
import { readSettings, settingsPath, writeSettings } from "../cli/settings";
import { asPreset, inspectCredential, problem, remedy, usable } from "../cli/preflight";
import { carryHistory } from "../loop/carry";
import { createSession, type Session } from "../loop/session";
import { findPreset } from "../providers/catalog";
import { listModels } from "../providers/models";
import type { Provider } from "../providers/types";
import type { Registry } from "../registry/types";
import { permits, type VesnaConfig } from "../cli/config";
import type { ProviderHandle } from "../cli/context";
import { createEditor, applyKey, type EditorState } from "./editor";
import { emptyState } from "./emptystate";
import { resolveGlyphs, type Glyphs } from "./glyphs";
import { decodeKeys, type Key } from "./keys";
import { layout, panelWidths, type Frame, type ViewState } from "./layout";
import { chatsPane, gardenPane } from "./panes";
import { createSpec, digestOf, digestOfText, listSpecs, readSpec, readSpecFile, specPaths, specsRoot } from "../spec/store";
import { activeStage, type Approvable, type SpecTree } from "../spec/project";
import { splitPlan } from "../sdd/brief";
import type { SpecSink } from "../spec/sink";
import { wrapAnsi } from "./wrap";
import { spinnerFrame } from "./render";
import { createScreen, type Terminal } from "./screen";
import { resolveTheme, themeNames, type Theme } from "./theme";
import { copyToClipboard, systemCopyIo } from "./clipboard";
import { decide, facetOf, MODES, type Mode, type Policy } from "../policy/decide";
import { runBuild, type BuildLoopRequest } from "../sdd/loop";
import { buildState, pidAlive, readLockPid, type BuildState } from "../sdd/recover";
import { rememberAllow, suggestPattern } from "../policy/store";
import {
  listSessions,
  listSessionsSync,
  readSession,
  type OpenSession,
  type SessionEvent,
  type SessionSummary,
} from "../store/sessions";
import type { AgentMessage } from "../providers/types";
import { createTranscript, type Transcript } from "./transcript";

export interface AppDeps {
  registry: Registry;
  provider: Provider;
  config: VesnaConfig;
  theme: Theme;
  root: string;
  /** The project's own instructions, from .vesna/AGENTS.md. */
  notes?: string;
  /** Puts text on the clipboard. Injected so a test never touches the real one. */
  copy?: (text: string) => void | Promise<void>;
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
   * How long quitting waits for a cancelled build to write `build.stopped`
   * before leaving anyway. Ten seconds unless a test shortens it.
   */
  quitCeilingMs?: number;
}

export interface AppIo {
  terminal: Terminal;
  /** Raw terminal input. Chunks may split escape sequences. */
  input: AsyncIterable<string>;
  setRawMode?(enabled: boolean): void;
  /** Returns an unsubscribe function. */
  onResize?(handler: () => void): () => void;
}

/** One notch of the wheel. */
const WHEEL_LINES = 3;

/** How far page-up moves, as a fraction of the visible conversation. */
const PAGE_FRACTION = 0.8;

export async function runApp(deps: AppDeps, io: AppIo): Promise<number> {
  let theme = deps.theme;
  const glyphs = resolveGlyphs(process.env, deps.config.ascii);
  const screen = createScreen(io.terminal, {
    surface: theme.surface,
    mouse: deps.config.mouse !== false,
  });
  const transcript = createTranscript(theme, glyphs);

  let editor = createEditor();
  let session = newSession(deps, approve, deps.resumed, () => spec);
  let scroll = 0;
  let busy = false;
  let tick = 0;
  let quitting = false;
  let confirmExit = false;
  let turn: AbortController | null = null;
  // Whether this process has a build in flight. Not the log's `building`,
  // which a build killed in an earlier process leaves true forever — that
  // one must not trap the person here as well.
  let building = false;
  // The signal for the build in flight: /build cancel and quitting both
  // abort it, and the loop's own abort path writes the events. Null
  // whenever `building` is false.
  let buildController: AbortController | null = null;
  // Set once quitting has asked the build to stop, so a second quit on any
  // path neither aborts twice nor starts a second wait.
  let leaving = false;

  const submissions = createQueue<string>();

  // The frame a click lands on is the one the user is looking at, so the
  // mapping from row to message has to be the one most recently drawn.
  let shown: Frame | null = null;

  const draw = () => {
    if (quitting) return;
    shown = layout(currentView(), screen.size());
    screen.draw(shown);
  };

  /** Never scroll past the top, and never past the newest line. */
  function clampScroll(next: number): number {
    const size = screen.size();
    const wrapped = transcript
      .lines(Math.max(1, size.cols))
      .flatMap((line) => wrapAnsi(line, Math.max(1, size.cols)));
    const visible = conversationRows(size.rows);
    return Math.max(0, Math.min(next, Math.max(0, wrapped.length - visible)));
  }

  function currentView(): ViewState {
    const size = screen.size();
    const widths = panelWidths(size.cols, {
      left: showChats,
      // Nothing to show is not a column: the conversation takes the room.
      right: showGarden && spec !== null,
    });
    const paneRows = Math.max(0, size.rows);

    return {
      ...(widths.right > 0 && spec !== null
        ? {
            right: gardenPane(spec, {
              theme,
              glyphs,
              width: widths.right,
              rows: paneRows,
            }),
          }
        : {}),
      ...(widths.left > 0
        ? {
            left: chatsPane(chats, deps.record?.id, deps.root, {
              theme,
              glyphs,
              width: widths.left,
              rows: paneRows,
            }),
          }
        : {}),
      header: header(deps, theme, glyphs),
      transcript: transcript.lines(Math.max(1, size.cols)),
      targets: transcript.copyTargets(Math.max(1, size.cols)),
      empty: emptyState({ theme, glyphs, cols: size.cols, rows: size.rows }),
      editor,
      hint: hint(theme, busy, confirmExit, glyphs, policy.mode),
      status: status(theme, session, busy, tick, glyphs, policy.mode),
      scroll,
      panel: theme.panel,
      // The layout paints its own rule, prompt and input text through this,
      // rather than importing the theme and giving up its purity.
      paint: (role, text) => theme.paint(role, text),
      glyphs,
    };
  }

  /** Changes how much the agent may do without asking. */
  function setMode(mode: Mode): void {
    policy = { ...policy, mode };
    transcript.notice(`mode: ${mode}  ${MODE_HELP[mode]}`, "ok");
    draw();
  }

  /** Swaps the palette everywhere it shows. False when the name is unknown. */
  function applyTheme(name: string): boolean {
    if (!themeNames().includes(name)) return false;
    theme = resolveTheme(name, { depth: deps.theme.depth });
    transcript.setTheme(theme, glyphs);
    screen.setSurface(theme.surface);
    draw();
    return true;
  }

  /** Never lets a write to disk take the conversation down with it. */
  function remember(event: SessionEvent): void {
    void deps.record?.append(event).catch(() => {});
  }

  // While a question is on screen the next key answers it, rather than being
  // typed into a box the user cannot see behind the question. A `strict`
  // question takes only a typed y or n: enter is not a yes for it, because a
  // person leaning on enter to leave must not write a durable event.
  let awaiting: { resolve: (answer: string) => void; strict: boolean } | null = null;
  let policy: Policy = deps.policy ?? { mode: "ask", allow: {}, deny: {} };

  // The left column is asked for; the right one shows the work in hand.
  let showChats = false;
  let chats: SessionSummary[] = [];
  let showGarden = true;
  let spec: SpecTree | null = null;

  const specs = specsRoot(deps.root);

  function openSpec(slug: string): boolean {
    const tree = readSpec(specs, slug);
    if (tree === null) return false;
    spec = tree;
    showGarden = true;
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
        showGarden = true;
        transcript.notice(`plan: ${opened.title}  (ctrl-g hides it)`, "ok");
        return;
      }
    }
    if (spec !== null) spec = readSpec(specs, spec.id) ?? spec;
  }

  /**
   * `spec` read as a plain property access, from a function of its own —
   * not inline in `runApp`'s own body. TypeScript's flow analysis only ever
   * sees `spec` reassigned through calls to functions like `openSpec` and
   * `refreshSpec`, never a literal assignment in its own scope, so inline it
   * narrows `spec` to exactly its initial `null` and then refuses `.building`
   * as a property of `never`. A function boundary resets that to the
   * declared type, the same way `refreshSpec` above reads `spec` safely.
   *
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
   */
  async function askApproval(): Promise<void> {
    if (turn !== null || leaving || building) return;
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

    for (const [index, line] of question.lines.entries()) {
      transcript.notice(line, index === question.lines.length - 1 ? "warn" : "muted");
    }
    draw();

    const answer = await new Promise<string>((resolve) => {
      awaiting = { resolve, strict: true };
    });
    awaiting = null;
    if (answer === "y") {
      writeApproval(question.what, digest);
      refreshSpec();
      transcript.notice(approveOutcome(question.what, spec, true).message, "ok");
    } else {
      transcript.notice("not yet", "muted");
    }
    transcript.endTurn();
    draw();
  }

  function refreshChats(): void {
    if (deps.sessionsRoot === undefined) return;
    chats = listSessionsSync(deps.sessionsRoot, { cwd: deps.root });
  }

  function toggleChats(): void {
    showChats = !showChats;
    if (showChats) refreshChats();
    draw();
  }

  /**
   * Asks before an action, and remembers the answer when told to.
   *
   * The remembered rule covers the directory or the command rather than the
   * one file: a rule that answers only this exact path asks again on the next
   * file beside it, which teaches the user to stop reading the question.
   */
  async function approve(action: {
    node: string;
    input: Record<string, unknown>;
    cwd: string;
    effect?: "pure" | "write" | "external";
  }): Promise<"allow" | "deny"> {
    const verdict = decide(action, policy, deps.root);
    if (verdict === "allow") return "allow";
    if (verdict === "deny") {
      transcript.notice(
        policy.mode === "plan"
          ? `${action.node} refused: plan mode changes nothing — shift-tab to leave it`
          : `refused by policy: ${action.node}`,
        "warn",
      );
      draw();
      return "deny";
    }

    const facet = facetOf(action, deps.root) ?? "";
    const pattern = facet === "" ? "" : suggestPattern(action.node, facet);

    transcript.notice(`${action.node}  ${facet}`, "warn");
    transcript.notice(
      pattern === ""
        ? "[y] allow   [n] refuse"
        : `[y] allow once   [a] always ${pattern}   [n] refuse`,
      "muted",
    );
    draw();

    const answer = await new Promise<string>((resolve) => {
      awaiting = { resolve, strict: false };
    });
    awaiting = null;

    if (answer === "a" && pattern === "") {
      transcript.notice("allowed once — there is nothing here to make a rule from", "ok");
      draw();
      return "allow";
    }

    if (answer === "a") {
      policy = {
        ...policy,
        allow: { ...policy.allow, [action.node]: [...(policy.allow[action.node] ?? []), pattern] },
      };
      void rememberAllow(deps.root, action.node, pattern).catch(() => {});
      transcript.notice(`allowed, and remembered: ${pattern}`, "ok");
      draw();
      return "allow";
    }
    if (answer === "y") {
      transcript.notice("allowed once", "ok");
      draw();
      return "allow";
    }

    transcript.notice("refused", "warn");
    draw();
    return "deny";
  }

  function specCommand(argument: string): void {
    const [verb, ...rest] = argument.trim().split(/\s+/);
    const name = rest.join(" ");

    if (verb === "new") {
      if (name === "") {
        transcript.notice("/spec new <name>", "warn");
        return;
      }
      // Creating a spec opens it, which is a switch: see /spec open below.
      if (spec?.building === true) {
        transcript.notice(specSwitchBlocked(), "warn");
        return;
      }
      try {
        const made = createSpec(specs, name);
        openSpec(made.slug);
        transcript.notice(`spec ${made.slug}`, "ok");
      } catch (error) {
        transcript.notice((error as Error).message, "warn");
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
        transcript.notice(specSwitchBlocked(), "warn");
        return;
      }
      if (!openSpec(name)) {
        transcript.notice(`no spec called "${name}" — /spec for the list`, "warn");
        return;
      }
      transcript.notice(`spec ${name}`, "ok");
      return;
    }

    const found = listSpecs(specs);
    if (found.length === 0) {
      transcript.notice("no specs yet — /spec new <name>", "muted");
      return;
    }
    for (const entry of found) {
      const here = spec?.id === entry.slug;
      transcript.notice(`${here ? "* " : "  "}${entry.slug}  ${entry.title}`, here ? "ok" : "muted");
    }
    transcript.notice("/spec open <slug>", "muted");
  }

  /** The last listing, so /resume can take a number rather than an id. */
  let listed: SessionSummary[] = [];

  async function showHistory(argument: string): Promise<void> {
    const root = deps.sessionsRoot;
    if (root === undefined) {
      transcript.notice("history is not available in this session", "warn");
      return;
    }

    const everywhere = argument.trim() === "all";
    const all = await listSessions(root, everywhere ? {} : { cwd: deps.root });
    // Resuming the conversation you are already having is not a thing.
    listed = all.filter((entry) => entry.id !== deps.record?.id);

    if (listed.length === 0) {
      transcript.notice(
        everywhere ? "no conversations yet" : "no conversations from this folder — /history all",
        "muted",
      );
      return;
    }

    transcript.notice(everywhere ? "all folders" : deps.root, "muted");
    for (const [index, entry] of listed.entries()) {
      const when = entry.updatedAt.slice(0, 16).replace("T", " ");
      const cost = entry.costUsd > 0 ? `  $${entry.costUsd.toFixed(2)}` : "";
      transcript.notice(
        `${String(index + 1).padStart(2)}  ${when}  ${entry.title}${cost}`,
        "muted",
      );
    }
    transcript.notice(`/resume <number> to reopen${everywhere ? "" : " · /history all"}`, "muted");
  }

  async function resume(argument: string): Promise<void> {
    const which = Number.parseInt(argument.trim(), 10);
    if (Number.isNaN(which) || listed[which - 1] === undefined) {
      transcript.notice("/resume <number> from the last /history listing", "warn");
      return;
    }
    await resumeById(listed[which - 1]!.id);
  }

  /** Reopening by id, whether that came from a listing or from a click. */
  async function resumeById(id: string): Promise<void> {
    const root = deps.sessionsRoot;
    if (root === undefined) {
      transcript.notice("history is not available in this session", "warn");
      return;
    }

    const stored = await readSession(root, id);
    if (stored === null) {
      transcript.notice("that conversation is no longer on disk", "warn");
      return;
    }

    // Rebuilt rather than summarised: the screen shows what was said, and the
    // model is seeded with the messages it actually saw.
    transcript.clear();
    const messages: AgentMessage[] = [];
    for (const event of stored.events) {
      if (event.t === "user") transcript.user(event.text);
      else if (event.t === "answer") {
        transcript.delta(event.raw);
        transcript.endTurn();
      } else if (event.t === "step") {
        transcript.step(event.nodeType, event.durationMs, event.detail);
      } else if (event.t === "messages") messages.push(...event.added);
    }

    session = newSession(deps, approve, messages, () => spec);
    scroll = 0;
    showChats = false;
    transcript.notice(`resumed · ${stored.summary.title}`, "ok");
    // Called straight from a click as well as from the command loop, so it
    // cannot rely on someone else redrawing afterwards.
    draw();
  }

  async function copy(text: string): Promise<void> {
    try {
      await (deps.copy ?? defaultCopy)(text);
      transcript.notice("copied", "ok");
    } catch (error) {
      transcript.notice(`could not copy: ${(error as Error).message}`, "error");
    }
    draw();
  }

  /**
   * Leaves — after cancelling a build in flight. Its promise would die with
   * the process otherwise, leaving the spec's log saying "building" with
   * nothing left to ever say otherwise. So the build is aborted through its
   * own signal, and the exit waits for the loop to write `build.stopped`.
   *
   * False means "not yet": the exit is coming, from `settled` below, once
   * the build has stopped. A caller must not exit on its own when it sees
   * false, and must not print a refusal — the transcript already says what
   * is happening. A second quit while the wait is on is absorbed here.
   */
  function leave(): boolean {
    if (building && buildController !== null) {
      if (leaving) return false;
      leaving = true;
      transcript.notice(quitCancelling(), "warn");
      transcript.endTurn();
      draw();
      buildController.abort();
      // Wait for the loop to write build.stopped, but not forever: a hung
      // provider call is cancelled by the same signal, so this is sub-second
      // in practice; ten seconds is the ceiling before leaving anyway.
      const deadline = Date.now() + (deps.quitCeilingMs ?? 10_000);
      const settled = new Promise<void>((resolve) => {
        const tick = () => {
          if (!building || Date.now() > deadline) return resolve();
          setTimeout(tick, 50);
        };
        tick();
      });
      void settled.then(() => {
        // Drawn before `quitting` is set: `draw` is a no-op after that, and
        // this is the one line a person needs to see on the way out.
        if (building) {
          transcript.notice(quitTimedOut(), "warn");
          transcript.endTurn();
          draw();
        }
        quitting = true;
        submissions.close();
      });
      return false; // the exit happens when the build has stopped
    }
    quitting = true;
    submissions.close();
    return true;
  }

  function dispatch(key: Key): void {
    // A question owns the keyboard until it is answered. Only the three
    // answers decide: a stray key must not refuse an action by accident.
    if (awaiting !== null) {
      const typed = key.type === "text" ? key.text.trim().slice(0, 1).toLowerCase() : "";
      const answer =
        typed === "y" || typed === "n" || (typed === "a" && !awaiting.strict)
          ? typed
          : key.type === "interrupt" || key.type === "escape"
            ? "n"
            : key.type === "enter" && !awaiting.strict
              ? "y"
              : "";
      if (answer !== "") awaiting.resolve(answer);
      return;
    }

    if (key.type !== "interrupt") confirmExit = false;

    switch (key.type) {
      case "interrupt":
        if (turn !== null) {
          turn.abort();
          return;
        }
        if (editor.text !== "") {
          editor = createEditor(editor.history);
          draw();
          return;
        }
        if (confirmExit) {
          if (!leave()) {
            confirmExit = false;
            draw();
          }
          return;
        }
        confirmExit = true;
        draw();
        return;

      case "eof":
        if (editor.text === "" && turn === null && !leave()) draw();
        return;

      case "click": {
        const column = key.column;
        const target =
          column < (shown?.columns.left ?? 0)
            ? shown?.leftTargets?.[key.row]
            : column >= (shown?.columns.right ?? Number.MAX_SAFE_INTEGER)
              ? shown?.rightTargets?.[key.row]
              : shown?.targets?.[key.row];

        if (target === undefined) return;
        if (target.startsWith("session:")) {
          void resumeById(target.slice("session:".length));
          return;
        }
        const text = transcript.rawOf(target);
        if (text !== undefined) void copy(text);
        return;
      }

      case "wheel-up":
      case "wheel-down": {
        // Three lines a notch: what every other scrollable surface does.
        const step = key.type === "wheel-up" ? WHEEL_LINES : -WHEEL_LINES;
        scroll = clampScroll(scroll + step);
        draw();
        return;
      }

      case "page-up":
      case "page-down": {
        const page = Math.max(1, Math.floor(conversationRows(screen.size().rows) * PAGE_FRACTION));
        scroll = clampScroll(scroll + (key.type === "page-up" ? page : -page));
        draw();
        return;
      }

      case "panel-left":
        toggleChats();
        return;

      case "cycle-mode": {
        setMode(nextMode(policy.mode));
        return;
      }

      case "panel-right":
        showGarden = !showGarden;
        draw();
        return;

      case "escape":
        if (turn !== null) turn.abort();
        return;

      default: {
        const applied = applyKey(editor, key);
        editor = applied.state;
        // Typing means the user is done reading back; snap to the newest.
        if (applied.submit !== undefined) {
          scroll = 0;
          submissions.push(applied.submit);
        }
        draw();
      }
    }
  }

  io.setRawMode?.(true);
  screen.enter();
  const stopResize = io.onResize?.(draw);
  draw();

  // Input is read alongside the turn in progress: an interrupt that only
  // arrived after the answer finished would not be an interrupt.
  const reading = (async () => {
    let carry = "";
    for await (const chunk of io.input) {
      const decoded = decodeKeys(carry + chunk);
      carry = decoded.rest;
      for (const key of decoded.keys) dispatch(key);
      if (quitting) break;
    }
    submissions.close();
  })();

  try {
    while (true) {
      const line = await submissions.take();
      if (line === null) break;
      // Once quitting has asked the build to stop, the person has said
      // they are leaving: a message typed into the wait must not start a
      // turn that runs, tools and all, behind a frame that no longer draws.
      if (leaving) continue;
      const input = parseChatInput(line);

      if (input.kind === "blank") continue;
      if (input.kind === "unknown") {
        transcript.user(line);
        transcript.notice(`unknown command /${input.name} - try /help`, "warn");
        transcript.endTurn();
        draw();
        continue;
      }

      transcript.user(line);
      // A slash command is control, not conversation: recording it would make
      // "/history" the title of the session and put it in its own listing.
      if (input.kind === "message") remember({ t: "user", text: line });
      draw();

      if (input.kind === "command") {
        if (input.name === "exit") {
          if (leave()) break;
          draw();
          continue;
        }

        if (input.name === "mode") {
          const wanted = input.argument.trim();
          if ((MODES as readonly string[]).includes(wanted)) setMode(wanted as Mode);
          else transcript.notice(`/mode plan, ask or auto — not "${wanted}"`, "warn");
          transcript.endTurn();
          draw();
          continue;
        }

        if (input.name === "spec") {
          specCommand(input.argument);
          transcript.endTurn();
          draw();
          continue;
        }

        if (input.name === "approve") {
          const outcome = approveOutcome(input.argument, spec, deps.sink !== undefined);
          if (outcome.kind === "approved" && deps.sink !== undefined) {
            writeApproval(outcome.what);
            refreshSpec();
            transcript.notice(outcome.message, "ok");
          } else {
            transcript.notice(outcome.message, "warn");
          }
          transcript.endTurn();
          draw();
          continue;
        }

        if (input.name === "classify") {
          const outcome = classifyOutcome(input.argument, spec, deps.sink !== undefined);
          if (outcome.kind === "classified" && deps.sink !== undefined) {
            deps.sink.emit({ t: "classified", shape: outcome.shape, by: "person" });
            refreshSpec();
            transcript.notice(outcome.message, "ok");
          } else {
            transcript.notice(outcome.message, "warn");
          }
          transcript.endTurn();
          draw();
          continue;
        }

        if (input.name === "build") {
          // The log may have moved under this chat — a build run and killed
          // in another process — and the lock is read fresh below, so the
          // tree it is judged against has to be fresh too.
          refreshSpec();
          // This process's own build comes first, from its own flag: the
          // loop checks the checkout before it takes the lock, so for a
          // moment after a launch the log and the lock still read as dead,
          // and a second `/build resume` typed inside that moment would
          // launch a second loop — whose losing `.then` would then clear
          // `building` under the winner. Only cancel gets through.
          if (building && buildController !== null && input.argument.trim() !== "cancel") {
            transcript.notice(buildBusy(), "warn");
            transcript.endTurn();
            draw();
            continue;
          }
          // A word after /build is cancel, or one of the three recoveries.
          // Cancel only aborts: the loop's abort path writes task.failed and
          // build.stopped, and `onEvent` below prints them as they land.
          let recovery: BuildLoopRequest["recovery"];
          if (input.argument.trim() !== "") {
            const outcome = recoverOutcome(input.argument, spec, building ? "running" : currentBuildState());
            if (outcome.kind === "refused") {
              transcript.notice(outcome.message, "warn");
              transcript.endTurn();
              draw();
              continue;
            }
            if (outcome.kind === "cancel") {
              // "running" is the lock's word, and the lock may be another
              // process's — `vesna build` in a second terminal. This chat
              // has nothing to abort then, and must not say it did.
              if (buildController === null) {
                transcript.notice(cancelElsewhere(), "warn");
              } else {
                buildController.abort();
                transcript.notice(outcome.message, "ok");
              }
              transcript.endTurn();
              draw();
              continue;
            }
            recovery = { action: outcome.action, ...(outcome.task !== undefined ? { task: outcome.task } : {}) };
            transcript.notice(outcome.message, "ok");
          } else {
            const start = buildStart(spec, currentBuildState());
            if (start.kind === "refused") {
              transcript.notice(start.message, "warn");
              transcript.endTurn();
              draw();
              continue;
            }
            transcript.notice(start.message, "ok");
          }
          // `buildStart` only returns "start" once the plan is approved, and
          // a plan can only be approved above through /approve, which itself
          // requires a sink — so `deps.sink` is never undefined here. Guarded
          // anyway, the same way /approve guards its own sink-dependent write,
          // rather than trusting that invariant with a bare assertion.
          if (deps.sink === undefined) {
            transcript.endTurn();
            draw();
            continue;
          }
          transcript.endTurn();
          draw();
          // Runs alongside the conversation. Each event redraws the garden and
          // adds a line, so the person watches it happen rather than waiting.
          building = true;
          buildController = new AbortController();
          void runBuild({
            root: deps.root,
            specsRoot: specsRoot(deps.root),
            slug: deps.sink.slug!,
            provider: deps.provider,
            registry: deps.registry,
            policy,
            permit: (type) => permits(deps.config, type),
            ...(deps.notes !== undefined ? { notes: deps.notes } : {}),
            ...(recovery !== undefined ? { recovery } : {}),
            signal: buildController.signal,
            ...deps.buildSeams,
            onEvent: (event) => {
              // "building" from `build.started` would just repeat the line
              // `buildStart` already printed above; `build.recovered` has no
              // line of its own — the recovery notice above is it.
              if (event.t !== "build.started") {
                const line = describeEvent(event);
                if (line !== null) transcript.notice(line, event.t === "build.stopped" ? "warn" : "muted");
              }
              refreshSpec();
              draw();
            },
          })
            .then((outcome) => {
              building = false;
              buildController = null;
              // A stop already reached the transcript as its `build.stopped`
              // event above; only a build that never started has no event
              // to carry its reason.
              if (outcome.status === "could-not-start") transcript.notice(outcome.reason, "warn");
              refreshSpec();
              draw();
            })
            .catch((error) => {
              building = false;
              buildController = null;
              // A build can reject rather than resolve: an ordinary git
              // failure deep inside a worker's own commit throws a plain
              // `Error`, which `runBuild` does not catch into a `Stop`. Left
              // unhandled that takes the whole TUI down mid-conversation —
              // so it lands in the transcript instead, the same way every
              // other fire-and-forget write in this file guards itself.
              transcript.notice(buildFailed(error as Error), "error");
              refreshSpec();
              draw();
            });
          continue;
        }

        if (input.name === "chats") {
          toggleChats();
          continue;
        }

        if (input.name === "history") {
          await showHistory(input.argument);
          transcript.endTurn();
          draw();
          continue;
        }

        if (input.name === "resume") {
          await resume(input.argument);
          transcript.endTurn();
          draw();
          continue;
        }

        const modelBefore = (deps.provider as Partial<ProviderHandle>).model;
        session = await command(
          input.name,
          input.argument,
          deps,
          session,
          transcript,
          glyphs,
          copy,
          theme,
          applyTheme,
          (messages) => newSession(deps, approve, messages, () => spec),
        );
        // The stored conversation records which model answered it, and that
        // was the startup one for the whole file after a mid-session switch.
        const modelAfter = (deps.provider as Partial<ProviderHandle>).model;
        if (modelAfter !== undefined && modelAfter !== modelBefore) {
          remember({ t: "model", model: modelAfter });
        }
        transcript.endTurn();
        draw();
        continue;
      }

      busy = true;
      turn = new AbortController();
      const spinner = setInterval(() => {
        tick += 1;
        draw();
      }, 90);

      const before = session.messages.length;
      // An interrupted turn is a person taking the keyboard back: the second
      // ctrl-c the hint promises must arm the exit, not answer a question
      // they did not ask for. The question returns after a completed turn.
      let interrupted = false;
      try {
        await runTurn(session, input.text, transcript, turn.signal, draw, remember, refreshSpec);
      } catch (error) {
        // An abort is the user's own doing, and reads as a warning. A provider
        // that fell over is a failure, and gets the colour that says so.
        const aborted = turn.signal.aborted;
        interrupted = aborted;
        transcript.notice(
          aborted ? "interrupted" : (error as Error).message,
          aborted ? "warn" : "error",
        );
      } finally {
        clearInterval(spinner);
        turn = null;
        busy = false;

        const answer = transcript.lastAnswer();
        if (answer !== undefined) remember({ t: "answer", raw: answer });
        const added = session.messages.slice(before);
        if (added.length > 0) remember({ t: "messages", added });
        remember({
          t: "usage",
          inputTokens: session.usage.inputTokens,
          outputTokens: session.usage.outputTokens,
          costUsd: session.costUsd,
        });

        refreshSpec();
        transcript.endTurn();
        draw();
        if (!interrupted) await askApproval();
      }
    }
  } finally {
    quitting = true;
    stopResize?.();
    screen.leave();
    io.setRawMode?.(false);
    submissions.close();
    await Promise.race([reading, Promise.resolve()]);
  }

  return EXIT.ok;
}

async function runTurn(
  session: Session,
  text: string,
  transcript: Transcript,
  signal: AbortSignal,
  draw: () => void,
  onRecord: (event: SessionEvent) => void,
  onSpecChanged: () => void,
): Promise<void> {
  let streamed = false;
  const result = await session.send(text, {
    signal,
    onText(delta) {
      streamed = true;
      transcript.delta(delta);
      draw();
    },
    onStep(step) {
      transcript.step(step.nodeType, step.durationMs, detailOf(step.input));
      onSpecChanged();
      onRecord({
        t: "step",
        nodeType: step.nodeType,
        durationMs: step.durationMs,
        ...(detailOf(step.input) ? { detail: detailOf(step.input)! } : {}),
      });
      draw();
    },
  });

  // A provider that does not stream never called onText.
  if (!streamed && result.text) transcript.delta(result.text);
}

/** The one field worth showing next to a step, when there is an obvious one. */
function detailOf(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const field of ["path", "pattern", "command", "name"]) {
    const value = record[field];
    if (typeof value === "string" && value !== "") {
      return value.length > 48 ? `${value.slice(0, 45)}...` : value;
    }
  }
  return undefined;
}

async function command(
  name: string,
  argument: string,
  deps: AppDeps,
  session: Session,
  transcript: Transcript,
  glyphs: Glyphs,
  onCopy: (text: string) => Promise<void>,
  theme: Theme,
  setTheme: (name: string) => boolean,
  makeSession: (messages?: AgentMessage[]) => Session,
): Promise<Session> {

  if (name === "help") {
    for (const entry of CHAT_COMMANDS) {
      transcript.notice(`${`/${entry.name}`.padEnd(14)} ${entry.help}`, "muted");
    }
    transcript.notice(
      `shift-up/down or pgup/pgdn scroll ${glyphs.bullet} alt-enter newline ${glyphs.bullet} ctrl-c interrupt`,
      "muted",
    );
    return session;
  }

  if (name === "cost") {
    const { usage } = session;
    transcript.notice(
      `${usage.inputTokens} in ${glyphs.bullet} ${usage.outputTokens} out ${glyphs.bullet} $${session.costUsd.toFixed(4)}`,
      "muted",
    );
    return session;
  }

  if (name === "theme") {
    const wanted = argument.trim();
    if (wanted === "") {
      for (const available of themeNames()) {
        const mark = available === theme.name ? "  (current)" : "";
        transcript.notice(`${available.padEnd(8)}${mark}`, available === theme.name ? "ok" : "muted");
      }
      return session;
    }
    if (!setTheme(wanted)) {
      transcript.notice(`no theme called "${wanted}" — try /theme for the list`, "warn");
      return session;
    }
    // Rewriting the user's config would cost them their comments and layout.
    transcript.notice(`theme: ${wanted}  (this session; set theme: in the config to keep it)`, "ok");
    return session;
  }

  if (name === "copy") {
    const answer = transcript.lastAnswer();
    if (answer === undefined) {
      transcript.notice("nothing to copy yet", "warn");
      return session;
    }
    await onCopy(answer);
    return session;
  }

  if (name === "clear") {
    transcript.clear();
    transcript.notice("new conversation", "muted");
    return makeSession();
  }

  if (name === "provider") {
    // The TUI is always handed a ProviderHandle (see buildContext in
    // src/cli/context.ts) — the plain Provider in AppDeps is the interface
    // every other consumer needs, and this is the one place that needs more.
    const handle = deps.provider as ProviderHandle;
    const env = deps.env ?? process.env;
    const wanted = argument.trim();

    if (wanted === "") {
      for (const line of describeProviders(handle.preset.id, env)) {
        transcript.notice(line, "muted");
      }
      return session;
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
      transcript.notice(outcome.message, "warn");
      return session;
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
      transcript.notice(blocked.message, "warn");
      for (const line of blocked.hints) transcript.notice(line, "muted");
      return session;
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
      transcript.notice(outcome.message, "ok");
      return session;
    }

    // Build the replacement before writing anything or touching the session:
    // a host that refuses the connection must leave both exactly as they
    // were, rather than half-applying a switch that never completed.
    try {
      await handle.switch(preset, preset.model, preset.baseUrl);
    } catch (error) {
      transcript.notice(switchFailed(preset.id, error as Error), "error");
      return session;
    }
    writeSettings(path, settings);
    transcript.notice(outcome.message, "ok");
    return makeSession(carried.messages);
  }

  if (name === "model") {
    // Same reasoning as /provider above: AppDeps hands out a plain Provider,
    // but the TUI always receives the richer handle that can report and
    // switch model.
    const handle = deps.provider as ProviderHandle;
    const wanted = argument.trim();

    if (wanted === "") {
      // The handle's own baseUrl, not deps.config.baseUrl: after a /provider
      // switch the two can differ, and the config snapshot is stale.
      const models = await listModels(handle.preset, handle.baseUrl);
      for (const line of describeModels(models, handle.model)) {
        transcript.notice(line, "muted");
      }
      return session;
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
      transcript.notice(outcome.message, "warn");
      return session;
    }

    if (outcome.kind === "pinned") {
      // Only the machine default's model moves, and only that: its provider is
      // whatever the machine already chose. This project's pin is a fact about
      // this directory, so writing it into the machine default — which is what
      // `provider: handle.preset.id` did here — takes the one setting that was
      // supposed to stay local and makes it global.
      writeSettings(path, { ...machine, model: wanted });
      transcript.notice(outcome.message, "ok");
      return session;
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
      transcript.notice(switchFailed(wanted, error as Error), "error");
      return session;
    }
    writeSettings(path, settings);
    transcript.notice(outcome.message, "ok");
    // Rebuilt through the same path /provider uses: the dialect never
    // changes here, so carryHistory should never actually drop anything, but
    // the model the new session is seeded with has to come from newSession
    // reading the handle, not from the stale snapshot in deps.config.
    return makeSession(carried.messages);
  }

  return session;
}

function newSession(
  deps: AppDeps,
  approve: (action: {
    node: string;
    input: Record<string, unknown>;
    cwd: string;
    effect?: "pure" | "write" | "external";
  }) => Promise<"allow" | "deny">,
  resumed?: AgentMessage[],
  /** Reads the currently open spec. Called fresh on every turn, not just now. */
  getSpec?: () => SpecTree | null,
): Session {
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
      const tree = getSpec?.() ?? null;
      const slug = deps.sink?.slug;
      if (tree === null || slug === undefined || slug === null) return undefined;
      const paths = specPaths(specsRoot(deps.root), slug);
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

function header(deps: AppDeps, theme: Theme, glyphs: Glyphs): string {
  // The live handle, not deps.config: the config is how the process started,
  // and `/provider` and `/model` move the connection out from under it. A
  // plain Provider (most tests, and any consumer that never switches) carries
  // neither field, hence the fallbacks.
  const handle = deps.provider as Partial<ProviderHandle>;
  const { model, service } = describeHeader(
    handle.model ?? deps.config.model,
    handle.preset ?? deps.config.preset,
  );
  const dot = theme.paint("muted", glyphs.bullet);
  // Every span here paints. A bare one would close the run before it with
  // SGR 39 and then render at the terminal's own default foreground, because
  // only the background is re-established per row.
  return `${theme.paint("petal", glyphs.mark)} ${theme.paint("petal", "vesna")} ${dot} ${theme.paint("text", model)} ${dot} ${theme.paint("muted", service)}`;
}

function hint(theme: Theme, busy: boolean, confirmExit: boolean, glyphs: Glyphs, mode: Mode): string {
  if (confirmExit) return theme.paint("warn", "ctrl-c again to leave");
  if (busy) return theme.paint("muted", "ctrl-c interrupt");
  return theme.paint("muted", hintLine(mode, glyphs.bullet));
}

function status(
  theme: Theme,
  session: Session,
  busy: boolean,
  tick: number,
  glyphs: Glyphs,
  mode: Mode,
): string {
  const { usage } = session;
  const tokens = usage.inputTokens + usage.outputTokens;
  const cost = `$${session.costUsd.toFixed(4)}`;
  // The mode decides what the agent may do, so it is never off screen, and
  // painted by its own role so auto is never mistaken for ask.
  const body = `${theme.paint(modeRole(mode), mode)} ${theme.paint("muted", `${glyphs.bullet} ${formatTokens(tokens)} ${glyphs.bullet} ${cost}`)}`;
  // The body is painted in both branches, not just the idle one: after the
  // spinner's own run closes there is no foreground left in force.
  return busy
    ? `${theme.paint("petal", spinnerFrame(tick, glyphs.spinner))} ${body}`
    : body;
}

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k tok` : `${count} tok`;
}

function conversationRows(rows: number): number {
  return Math.max(1, rows - 4);
}

/**
 * A one-writer, one-reader queue. `take` resolves with the next item, or null
 * once the writer has closed it and the backlog is drained.
 *
 * Deliberately a plain promise rather than an async generator: handing items
 * over through `for await` leaves the reader waiting on the event loop rather
 * than on the microtask queue, and a submission then sits unhandled until the
 * next keypress happens to wake the loop.
 */
function createQueue<T>() {
  const items: T[] = [];
  let closed = false;
  let waiting: ((value: T | null) => void) | null = null;

  return {
    push(item: T) {
      const resolve = waiting;
      if (resolve !== null) {
        waiting = null;
        resolve(item);
        return;
      }
      items.push(item);
    },
    close() {
      closed = true;
      const resolve = waiting;
      if (resolve !== null) {
        waiting = null;
        resolve(null);
      }
    },
    take(): Promise<T | null> {
      if (items.length > 0) return Promise.resolve(items.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise<T | null>((resolve) => {
        waiting = resolve;
      });
    },
  };
}

/** The real clipboard, used when nothing was injected. */
async function defaultCopy(text: string): Promise<void> {
  const result = await copyToClipboard(text, systemCopyIo());
  if (result === "empty") throw new Error("nothing to copy");
  if (result === "too-large") throw new Error("too large for this terminal");
}

/** One line each, so the notice says what the mode actually means. */
const MODE_HELP: Record<Mode, string> = {
  plan: "look and propose; nothing is changed",
  ask: "you are asked before anything changes",
  auto: "changes go ahead, except the irreversible",
};
