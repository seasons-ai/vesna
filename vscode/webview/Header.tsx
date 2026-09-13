import type { PanelModel, ServerStatus } from "../src/state";
import { WORDS } from "../src/words";
import { post } from "./bridge";

/**
 * `model · service · $cost` from the last `state`, a Stop button while the
 * core is busy, and under it whatever the server status has to say — with
 * a Restart button when the server is gone.
 */
export function Header({ model }: { model: PanelModel }) {
  const state = model.state;
  return (
    <header className="header">
      <div className="header-line">
        <span className="header-facts">
          {state === null ? WORDS.appName : `${state.model} · ${state.service} · $${state.usage.costUsd.toFixed(4)}`}
        </span>
        {state?.busy === true && (
          <button type="button" className="button secondary" onClick={() => post({ kind: "interrupt" })}>
            {WORDS.stop}
          </button>
        )}
      </div>
      {model.note !== null && <div className="note">{model.note}</div>}
      <ServerBanner server={model.server} />
    </header>
  );
}

function ServerBanner({ server }: { server: ServerStatus }) {
  switch (server.kind) {
    case "up":
      return null;
    case "starting":
      return <div className="banner muted">{WORDS.starting}</div>;
    case "noFolder":
      return <div className="banner">{WORDS.noFolder}</div>;
    case "tooOld":
      return <div className="banner error">{WORDS.tooOld(server.server, server.extension)}</div>;
    case "unresponsive":
      return (
        <div className="banner error">
          <span>{WORDS.unresponsive}</span>
          <RestartButton />
        </div>
      );
    case "notFound":
      return (
        <div className="banner error">
          <span>
            {WORDS.notFound(server.command)} <code>{WORDS.installHint}</code>
          </span>
          <RestartButton />
        </div>
      );
    case "exited":
      return (
        <div className="banner error">
          <span>
            {WORDS.exited(server.code)}
            {server.stderr.trim() !== "" && <pre className="stderr">{server.stderr.trim()}</pre>}
          </span>
          <RestartButton />
        </div>
      );
  }
}

function RestartButton() {
  return (
    <button type="button" className="button" onClick={() => post({ kind: "restart" })}>
      {WORDS.restart}
    </button>
  );
}
