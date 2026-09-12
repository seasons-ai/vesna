/**
 * The chat view: a webview that draws the store's model and posts the five
 * `ToHost` messages back. The host keeps the model; the webview keeps
 * nothing — on every reduction the whole model is posted again.
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { Client } from "./client";
import type { Store } from "./state";
import type { ToHost, ToWebview } from "../webview/bridge";
import { WORDS } from "./words";

/** What the panel needs from the host: the live client (or none), and a restart. */
export interface PanelLink {
  client(): Client | null;
  restart(): Promise<void>;
}

export const CHAT_VIEW_ID = "vesna.chat";

export class VesnaPanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  /** Messages sent while the core was busy, in order — matched against the `user` echo when their turn starts. */
  private readonly queued: string[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: Store,
    private readonly link: PanelLink,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    const dist = vscode.Uri.joinPath(this.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [media, dist] };
    view.webview.html = html(view.webview, {
      script: view.webview.asWebviewUri(vscode.Uri.joinPath(dist, "webview.js")),
      style: view.webview.asWebviewUri(vscode.Uri.joinPath(media, "webview.css")),
    });

    const post = (): void => {
      const message: ToWebview = { kind: "model", model: this.store.model };
      void view.webview.postMessage(message);
    };
    const unsubscribe = this.store.subscribe(post);
    const receiving = view.webview.onDidReceiveMessage((message: ToHost) => this.receive(message));
    // The webview starts from `initialModel` every time it is (re)loaded.
    const visibility = view.onDidChangeVisibility(() => {
      if (view.visible) post();
    });
    view.onDidDispose(() => {
      unsubscribe();
      receiving.dispose();
      visibility.dispose();
      if (this.view === view) this.view = null;
    });
    post();
  }

  /** Brings the view forward; VS Code registers `<view id>.focus` for every contributed view. */
  focus(): void {
    void vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
  }

  /** A `user` echo from the server: if it is the head of the queue, that queued turn has started. */
  turnStartedIfQueued(text: string): void {
    if (this.queued[0] === text) {
      this.queued.shift();
      this.store.dispatch({ kind: "turnStarted" });
    }
  }

  /** A line the panel wants said when the server cannot be asked. */
  private notice(text: string, level: "warn" | "error" = "warn"): void {
    this.store.dispatch({ kind: "notification", n: { method: "transcript", params: { kind: "notice", text, level } } });
  }

  private receive(message: ToHost): void {
    if (message.kind === "restart") {
      void this.link.restart();
      return;
    }
    const client = this.link.client();
    if (client === null) {
      this.notice(WORDS.notRunning);
      return;
    }
    const settle = (run: Promise<void>): void => {
      run.catch((error: unknown) => this.notice((error as Error)?.message ?? String(error), "error"));
    };
    switch (message.kind) {
      case "send":
        // The reducer counts the turn as queued only while the core is busy;
        // the echo that starts it is matched in `turnStartedIfQueued`.
        if (this.store.model.state?.busy === true) this.queued.push(message.text);
        this.store.dispatch({ kind: "sent" });
        settle(client.send(message.text));
        return;
      case "command":
        settle(client.command(message.name, message.argument, message.typed));
        return;
      case "answer":
        settle(client.answer(message.id, message.value));
        return;
      case "interrupt":
        settle(client.interrupt());
        return;
    }
  }
}

function nonce(): string {
  return randomBytes(16).toString("base64");
}

function html(webview: vscode.Webview, uris: { script: vscode.Uri; style: vscode.Uri }): string {
  const n = nonce();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `script-src 'nonce-${n}'`,
    `img-src ${webview.cspSource} data:`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${uris.style.toString()}">
<title>Vesna</title>
</head>
<body>
<div id="root"></div>
<script nonce="${n}" src="${uris.script.toString()}"></script>
</body>
</html>`;
}
