import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { initialModel, type PanelModel } from "../src/state";
import { App } from "./App";
import { bindHost, isRejected, type HostApi, type ToWebview } from "./bridge";

declare function acquireVsCodeApi(): HostApi;

// VS Code hands this out once per webview; the bridge keeps the handle.
bindHost(acquireVsCodeApi());

/**
 * Listens for the host's models and draws the latest. Deltas can arrive
 * faster than frames, so the newest model waits for the next animation
 * frame and only that one is set — the ones in between were never shown.
 */
function Root() {
  const [model, setModel] = useState<PanelModel>(initialModel);
  // A line the host handed back, numbered so the same text twice is two events.
  const [rejected, setRejected] = useState<{ text: string; seq: number } | null>(null);

  useEffect(() => {
    let pending: PanelModel | null = null;
    let frame: number | null = null;
    let seq = 0;
    const onMessage = (event: MessageEvent<ToWebview>) => {
      if (isRejected(event.data)) {
        seq += 1;
        setRejected({ text: event.data.text, seq });
        return;
      }
      if (event.data?.kind !== "model") return;
      pending = event.data.model;
      frame ??= requestAnimationFrame(() => {
        frame = null;
        if (pending !== null) setModel(pending);
        pending = null;
      });
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  return <App model={model} rejected={rejected} />;
}

createRoot(document.getElementById("root")!).render(<Root />);
