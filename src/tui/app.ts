import {
  CHAT_COMMANDS,
  buildBusy,
  buildFailed,
  buildStart,
  cancelElsewhere,
  hintLine,
  modeRole,
  nextMode,
  parseChatInput,
  quitCancelling,
  quitTimedOut,
  recoverOutcome,
} from "../cli/chatcmd";
import { describeEvent } from "../cli/buildcmd";
import { EXIT } from "../cli/exit";
import { permits } from "../cli/config";
import { createEditor, applyKey } from "./editor";
import { emptyState } from "./emptystate";
import { resolveGlyphs, type Glyphs } from "./glyphs";
import { decodeKeys, type Key } from "./keys";
import { layout, panelWidths, type Frame, type ViewState } from "./layout";
import { chatsPane, gardenPane } from "./panes";
import { specsRoot } from "../spec/store";
import { wrapAnsi } from "./wrap";
import { spinnerFrame } from "./render";
import { createScreen, type Terminal } from "./screen";
import { resolveTheme, themeNames, type Theme } from "./theme";
import { copyToClipboard, systemCopyIo } from "./clipboard";
import type { Mode } from "../policy/decide";
import { runBuild, type BuildLoopRequest } from "../sdd/loop";
import { createTranscript, type Transcript } from "./transcript";
import { createCore, type CoreDeps } from "../core/core";
import type { State } from "../core/types";
import { detailOf } from "../loop/trace";

export interface AppDeps extends CoreDeps {
  theme: Theme;
  /** Puts text on the clipboard. Injected so a test never touches the real one. */
  copy?: (text: string) => void | Promise<void>;
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

  // The agent itself. Everything drawn below comes from what it says: the
  // transcript as it grows, and the state as the core last reported it.
  const core = createCore(deps);
  let state: State = core.snapshot();

  let editor = createEditor();
  let scroll = 0;
  let tick = 0;
  let quitting = false;
  let confirmExit = false;
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

  // What the core says arrives one line at a time — a replayed conversation
  // is hundreds of them in one go — and one frame at the end of the burst is
  // the same frame as one after each.
  let drawPending = false;
  const scheduleDraw = () => {
    if (drawPending) return;
    drawPending = true;
    queueMicrotask(() => {
      drawPending = false;
      draw();
    });
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
    const { spec, chats } = state;
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
            left: chatsPane(chats ?? [], deps.record?.id, deps.root, {
              theme,
              glyphs,
              width: widths.left,
              rows: paneRows,
            }),
          }
        : {}),
      header: header(state, theme, glyphs),
      transcript: transcript.lines(Math.max(1, size.cols)),
      targets: transcript.copyTargets(Math.max(1, size.cols)),
      empty: emptyState({ theme, glyphs, cols: size.cols, rows: size.rows }),
      editor,
      hint: hint(theme, state.busy, confirmExit, glyphs, state.mode),
      status: status(theme, state, tick, glyphs),
      scroll,
      panel: theme.panel,
      // The layout paints its own rule, prompt and input text through this,
      // rather than importing the theme and giving up its purity.
      paint: (role, text) => theme.paint(role, text),
      glyphs,
    };
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

  // While a question is on screen the next key answers it, rather than being
  // typed into a box the user cannot see behind the question. A `strict`
  // question takes only a typed y or n: enter is not a yes for it, because a
  // person leaning on enter to leave must not write a durable event.
  let awaiting: { resolve: (answer: string) => void; strict: boolean } | null = null;

  // The left column is asked for; the right one shows the work in hand.
  let showChats = false;
  let showGarden = true;
  // Set while a stored conversation is being reopened, so the clear that
  // starts the replay is known to be that and not a /clear.
  let resuming = false;

  core.on((notification) => {
    switch (notification.method) {
      case "transcript": {
        const entry = notification.params;
        switch (entry.kind) {
          case "user":
            transcript.user(entry.text);
            break;
          case "delta":
            transcript.delta(entry.text);
            break;
          case "step":
            transcript.step(entry.step.nodeType, entry.step.durationMs, detailOf(entry.step.input));
            break;
          case "notice":
            transcript.notice(entry.text, entry.level);
            break;
          case "turn-end":
            transcript.endTurn();
            break;
          case "clear":
            transcript.clear();
            // What was there is gone, so there is nothing to be scrolled
            // back into; a reopened conversation also closes the column
            // it was picked from.
            scroll = 0;
            if (resuming) showChats = false;
            break;
        }
        scheduleDraw();
        return;
      }
      case "state": {
        // A spec that was just opened — by the person or by the agent
        // planning — is shown; hiding it again is ctrl-g, as before.
        const next = notification.params;
        if (next.specSlug !== null && next.specSlug !== state.specSlug) showGarden = true;
        state = next;
        scheduleDraw();
        return;
      }
      case "ask": {
        // The question's lines are notices, painted as the prompt always was:
        // a permission is its action in warn and its choices muted; an
        // approval lists what is approved muted and asks in warn.
        const ask = notification.params;
        for (const [index, line] of ask.lines.entries()) {
          const last = index === ask.lines.length - 1;
          const tone = ask.kind === "permission" ? (index === 0 ? "warn" : "muted") : last ? "warn" : "muted";
          transcript.notice(line, tone);
        }
        awaiting = { resolve: (value) => void core.answer(ask.id, value), strict: ask.strict };
        scheduleDraw();
        return;
      }
      case "ask.resolved":
        awaiting = null;
        return;
    }
  });

  async function toggleChats(): Promise<void> {
    showChats = !showChats;
    if (showChats) await core.command("chats", "");
    draw();
  }

  /** Reopens a stored conversation, from the list or from a click on it. */
  async function resume(argument: string): Promise<void> {
    resuming = true;
    try {
      await core.command("resume", argument);
    } finally {
      resuming = false;
    }
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
        if (state.busy) {
          core.interrupt();
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
        if (editor.text === "" && !state.busy && !leave()) draw();
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
          void resume(target.slice("session:".length));
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
        void toggleChats();
        return;

      case "cycle-mode": {
        void core.command("mode", nextMode(state.mode));
        return;
      }

      case "panel-right":
        showGarden = !showGarden;
        draw();
        return;

      case "escape":
        if (state.busy) core.interrupt();
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
      // A slash command is control, not conversation: it is quoted back
      // here, never sent, and so never recorded as what was said.
      transcript.user(line);
      draw();

      if (input.kind === "unknown") {
        await core.command(input.name, "");
        draw();
        continue;
      }

      if (input.kind === "command") {
        if (input.name === "exit") {
          if (leave()) break;
          draw();
          continue;
        }

        // Opening a spec, even one already open and hidden, is asking to see it.
        if (input.name === "spec" && /^(new|open)(\s|$)/.test(input.argument.trim())) showGarden = true;

        if (input.name === "build") {
          // The log may have moved under this chat — a build run and killed
          // in another process — and the lock is read fresh below, so the
          // tree it is judged against has to be fresh too.
          core.refreshSpec();
          const spec = state.spec;
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
            const outcome = recoverOutcome(input.argument, spec, building ? "running" : core.currentBuildState());
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
            const start = buildStart(spec, core.currentBuildState());
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
          core.setBuilding(true);
          buildController = new AbortController();
          void runBuild({
            root: deps.root,
            specsRoot: specsRoot(deps.root),
            slug: deps.sink.slug!,
            provider: deps.provider,
            registry: deps.registry,
            policy: core.policy(),
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
              core.refreshSpec();
            },
          })
            .then((outcome) => {
              building = false;
              core.setBuilding(false);
              buildController = null;
              // A stop already reached the transcript as its `build.stopped`
              // event above; only a build that never started has no event
              // to carry its reason.
              if (outcome.status === "could-not-start") transcript.notice(outcome.reason, "warn");
              core.refreshSpec();
            })
            .catch((error) => {
              building = false;
              core.setBuilding(false);
              buildController = null;
              // A build can reject rather than resolve: an ordinary git
              // failure deep inside a worker's own commit throws a plain
              // `Error`, which `runBuild` does not catch into a `Stop`. Left
              // unhandled that takes the whole TUI down mid-conversation —
              // so it lands in the transcript instead, the same way every
              // other fire-and-forget write in this file guards itself.
              transcript.notice(buildFailed(error as Error), "error");
              core.refreshSpec();
            });
          continue;
        }

        // The column and the palette are the screen's; the rest is the agent's.
        if (input.name === "chats") {
          await toggleChats();
          continue;
        }

        if (input.name === "resume") {
          await resume(input.argument);
          continue;
        }

        if (input.name === "help" || input.name === "cost" || input.name === "theme" || input.name === "copy") {
          await command(input.name, input.argument, state, transcript, glyphs, copy, theme, applyTheme);
          transcript.endTurn();
          draw();
          continue;
        }

        await core.command(input.name, input.argument);
        draw();
        continue;
      }

      // The core quotes the message back and says what the model says; the
      // spinner is the one thing here that is the screen's own.
      const spinner = setInterval(() => {
        tick += 1;
        draw();
      }, 90);
      try {
        await core.send(line);
      } finally {
        clearInterval(spinner);
        draw();
      }
    }
  } finally {
    quitting = true;
    stopResize?.();
    screen.leave();
    io.setRawMode?.(false);
    submissions.close();
    await core.close();
    await Promise.race([reading, Promise.resolve()]);
  }

  return EXIT.ok;
}

/** The commands that are the screen's own: what it shows, and how. */
async function command(
  name: string,
  argument: string,
  state: State,
  transcript: Transcript,
  glyphs: Glyphs,
  onCopy: (text: string) => Promise<void>,
  theme: Theme,
  setTheme: (name: string) => boolean,
): Promise<void> {
  if (name === "help") {
    for (const entry of CHAT_COMMANDS) {
      transcript.notice(`${`/${entry.name}`.padEnd(14)} ${entry.help}`, "muted");
    }
    transcript.notice(
      `shift-up/down or pgup/pgdn scroll ${glyphs.bullet} alt-enter newline ${glyphs.bullet} ctrl-c interrupt`,
      "muted",
    );
    return;
  }

  if (name === "cost") {
    const { usage } = state;
    transcript.notice(
      `${usage.inputTokens} in ${glyphs.bullet} ${usage.outputTokens} out ${glyphs.bullet} $${usage.costUsd.toFixed(4)}`,
      "muted",
    );
    return;
  }

  if (name === "theme") {
    const wanted = argument.trim();
    if (wanted === "") {
      for (const available of themeNames()) {
        const mark = available === theme.name ? "  (current)" : "";
        transcript.notice(`${available.padEnd(8)}${mark}`, available === theme.name ? "ok" : "muted");
      }
      return;
    }
    if (!setTheme(wanted)) {
      transcript.notice(`no theme called "${wanted}" — try /theme for the list`, "warn");
      return;
    }
    // Rewriting the user's config would cost them their comments and layout.
    transcript.notice(`theme: ${wanted}  (this session; set theme: in the config to keep it)`, "ok");
    return;
  }

  if (name === "copy") {
    const answer = transcript.lastAnswer();
    if (answer === undefined) {
      transcript.notice("nothing to copy yet", "warn");
      return;
    }
    await onCopy(answer);
  }
}
function header(state: State, theme: Theme, glyphs: Glyphs): string {
  // The model and the service as the core last reported them: `/provider`
  // and `/model` move the connection, and the state follows.
  const { model, service } = state;
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

function status(theme: Theme, state: State, tick: number, glyphs: Glyphs): string {
  const { usage, mode } = state;
  const tokens = usage.inputTokens + usage.outputTokens;
  const cost = `$${usage.costUsd.toFixed(4)}`;
  // The mode decides what the agent may do, so it is never off screen, and
  // painted by its own role so auto is never mistaken for ask.
  const body = `${theme.paint(modeRole(mode), mode)} ${theme.paint("muted", `${glyphs.bullet} ${formatTokens(tokens)} ${glyphs.bullet} ${cost}`)}`;
  // The body is painted in both branches, not just the idle one: after the
  // spinner's own run closes there is no foreground left in force.
  return state.busy
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
