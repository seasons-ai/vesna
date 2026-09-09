import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as toYaml } from "yaml";
import { applyParameters } from "../crystallize/apply";
import { proposeFlow } from "../crystallize/propose";
import { CHAT_COMMANDS, parseChatInput } from "../cli/chatcmd";
import { describeDropped } from "../cli/dropped";
import { EXIT } from "../cli/exit";
import { formatParameter } from "../cli/format";
import { createSession, type Session } from "../loop/session";
import type { Provider } from "../providers/types";
import type { Registry } from "../registry/types";
import type { TraceStore } from "../store/types";
import type { VesnaConfig } from "../cli/config";
import { createEditor, applyKey, type EditorState } from "./editor";
import { emptyState } from "./emptystate";
import { resolveGlyphs, type Glyphs } from "./glyphs";
import { decodeKeys, type Key } from "./keys";
import { layout, type ViewState } from "./layout";
import { spinnerFrame } from "./render";
import { createScreen, type Terminal } from "./screen";
import type { Theme } from "./theme";
import { createTranscript, type Transcript } from "./transcript";

export interface AppDeps {
  registry: Registry;
  provider: Provider;
  store: TraceStore;
  config: VesnaConfig;
  theme: Theme;
  root: string;
  /** The project's own instructions, from .vesna/AGENTS.md. */
  notes?: string;
}

export interface AppIo {
  terminal: Terminal;
  /** Raw terminal input. Chunks may split escape sequences. */
  input: AsyncIterable<string>;
  setRawMode?(enabled: boolean): void;
  /** Returns an unsubscribe function. */
  onResize?(handler: () => void): () => void;
}

/** How far page-up moves, as a fraction of the visible conversation. */
const PAGE_FRACTION = 0.8;

export async function runApp(deps: AppDeps, io: AppIo): Promise<number> {
  const { theme } = deps;
  const glyphs = resolveGlyphs(process.env, deps.config.ascii);
  const screen = createScreen(io.terminal, { surface: theme.surface });
  const transcript = createTranscript(theme, glyphs);

  let editor = createEditor();
  let session = newSession(deps);
  let scroll = 0;
  let busy = false;
  let tick = 0;
  let quitting = false;
  let confirmExit = false;
  let turn: AbortController | null = null;

  const submissions = createQueue<string>();

  const draw = () => {
    if (quitting) return;
    screen.draw(layout(currentView(), screen.size()));
  };

  function currentView(): ViewState {
    const size = screen.size();
    return {
      header: header(deps, glyphs),
      transcript: transcript.lines(),
      empty: emptyState({ theme, glyphs, cols: size.cols, rows: size.rows }),
      editor,
      hint: hint(theme, busy, confirmExit, glyphs),
      status: status(deps, session, busy, tick, glyphs),
      scroll,
      panel: theme.panel,
      // The layout paints its own rule, prompt and input text through this,
      // rather than importing the theme and giving up its purity.
      paint: (role, text) => theme.paint(role, text),
      glyphs,
    };
  }

  function dispatch(key: Key): void {
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
          quitting = true;
          submissions.close();
          return;
        }
        confirmExit = true;
        draw();
        return;

      case "eof":
        if (editor.text === "" && turn === null) {
          quitting = true;
          submissions.close();
        }
        return;

      case "page-up":
      case "page-down": {
        const page = Math.max(1, Math.floor(conversationRows(screen.size().rows) * PAGE_FRACTION));
        scroll = Math.max(0, scroll + (key.type === "page-up" ? page : -page));
        draw();
        return;
      }

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
      draw();

      if (input.kind === "command") {
        if (input.name === "exit") break;
        session = await command(input.name, input.argument, deps, session, transcript, glyphs);
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

      try {
        await runTurn(session, input.text, transcript, turn.signal, draw);
      } catch (error) {
        // An abort is the user's own doing, and reads as a warning. A provider
        // that fell over is a failure, and gets the colour that says so.
        const aborted = turn.signal.aborted;
        transcript.notice(
          aborted ? "interrupted" : (error as Error).message,
          aborted ? "warn" : "error",
        );
      } finally {
        clearInterval(spinner);
        turn = null;
        busy = false;
        transcript.endTurn();
        draw();
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
): Promise<Session> {
  const { theme } = deps;

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

  if (name === "clear") {
    transcript.clear();
    transcript.notice("new conversation", "muted");
    return newSession(deps);
  }

  if (name === "crystallize") {
    if (argument === "") {
      transcript.notice("/crystallize needs a name", "warn");
      return session;
    }
    const trace = await session.toTrace();
    if (trace.steps.length === 0) {
      transcript.notice("nothing to crystallise yet - no tools were used", "warn");
      return session;
    }

    const traceId = await deps.store.saveLiveTrace(trace);
    const proposal = proposeFlow(trace, argument);
    // The full-screen box has no room for a question per parameter, so every
    // proposal is applied and listed; `vesna crystallize <id>` asks one by one.
    const accepted = new Map(proposal.parameters.map((p) => [p.suggestedName, p.suggestedName]));
    const flow = applyParameters(proposal.flow, proposal.parameters, accepted);

    await mkdir(join(deps.root, ".vesna", "flows"), { recursive: true });
    const path = join(deps.root, ".vesna", "flows", `${flow.name}.yaml`);
    await writeFile(path, toYaml(flow));

    for (const parameter of proposal.parameters) transcript.notice(formatParameter(parameter), "muted");
    for (const line of describeDropped(proposal.dropped, theme)) transcript.notice(line.trim(), "muted");
    // Warm petal marks live work; cold ice marks what has been crystallised.
    // This line is the moment the metaphor is about.
    transcript.notice(`wrote ${path}`, "ice");
    transcript.notice(`trace ${traceId} ${glyphs.bullet} vesna run ${flow.name} --dry-run`, "muted");
  }

  return session;
}

function newSession(deps: AppDeps): Session {
  return createSession(deps.provider, deps.registry, {
    cwd: deps.root,
    model: deps.config.model,
    prices: deps.config.prices,
    notes: deps.notes,
    permit: (type) => deps.config.permissions.nodes.includes(type),
  });
}

function header(deps: AppDeps, glyphs: Glyphs): string {
  const { theme, config } = deps;
  const mode = config.provider === "openai" ? `${config.provider}/${config.auth}` : config.provider;
  const dot = theme.paint("muted", glyphs.bullet);
  // Every span here paints. A bare one would close the run before it with
  // SGR 39 and then render at the terminal's own default foreground, because
  // only the background is re-established per row.
  return `${theme.paint("petal", glyphs.mark)} ${theme.paint("petal", "vesna")} ${dot} ${theme.paint("text", config.model)} ${dot} ${theme.paint("muted", mode)}`;
}

function hint(theme: Theme, busy: boolean, confirmExit: boolean, glyphs: Glyphs): string {
  if (confirmExit) return theme.paint("warn", "ctrl-c again to leave");
  if (busy) return theme.paint("muted", "ctrl-c interrupt");
  return theme.paint("muted", `/help ${glyphs.bullet} alt-enter newline ${glyphs.bullet} ctrl-c twice to leave`);
}

function status(deps: AppDeps, session: Session, busy: boolean, tick: number, glyphs: Glyphs): string {
  const { usage } = session;
  const tokens = usage.inputTokens + usage.outputTokens;
  const cost = `$${session.costUsd.toFixed(4)}`;
  const body = `${formatTokens(tokens)} ${glyphs.bullet} ${cost}`;
  // The body is painted in both branches, not just the idle one: after the
  // spinner's own run closes there is no foreground left in force.
  return busy
    ? `${deps.theme.paint("petal", spinnerFrame(tick, glyphs.spinner))} ${deps.theme.paint("muted", body)}`
    : deps.theme.paint("muted", body);
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
