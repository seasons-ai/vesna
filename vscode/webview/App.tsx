import type { PanelModel } from "../src/state";
import { AskBlock } from "./AskBlock";
import { Composer } from "./Composer";
import { Header } from "./Header";
import { Transcript } from "./Transcript";

/**
 * The panel, top to bottom: header, transcript, the open question, the
 * composer. Everything drawn comes from `model`; the only state the tree
 * keeps for itself is the composer's text, which step cards are open, and
 * where the transcript is scrolled.
 */
export function App({ model }: { model: PanelModel }) {
  return (
    <div className="app">
      <Header model={model} />
      <Transcript entries={model.entries} />
      {model.ask !== null && <AskBlock key={model.ask.id} ask={model.ask} />}
      <Composer asking={model.ask !== null} queued={model.queued} />
    </div>
  );
}
