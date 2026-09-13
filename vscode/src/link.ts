/**
 * The one server of a window. `start` runs once on activation and again
 * only when a person asks (Restart in the panel, `vesna.restart`); nothing
 * here restarts a server on its own. The child is held from the moment it
 * is spawned — not from the handshake — so a server that never speaks is
 * still ours to kill, and a restart never leaves a second process behind.
 *
 * No `vscode` import: the spawner and the settings come in, so `bun test`
 * can drive two restarts over fakes and count the children.
 */
import type { Client } from "./client";
import type { Notification } from "./protocol";
import {
  DEACTIVATE_CEILING_MS,
  killIfAlive,
  startServer,
  stopServer,
  STOP_CEILING_MS,
  type ChildLike,
  type Spawner,
} from "./server";
import type { Settings } from "./settings";
import type { Store } from "./state";

export interface LinkOptions {
  root: string;
  extensionVersion: string;
  store: Store;
  onNotification: (n: Notification) => void;
  spawn: Spawner;
  /** Read once per start — the folder's own settings, not the window's. */
  settings: () => Settings;
  handshakeMs?: number;
  /** How long a restart waits for the old server before killing it. */
  restartCeilingMs?: number;
}

export class ServerLink {
  private client: Client | null = null;
  private child: ChildLike | null = null;
  /** Bumped per start, so a late callback from an old server changes nothing. */
  private generation = 0;

  constructor(private readonly opts: LinkOptions) {}

  current(): Client | null {
    return this.client;
  }

  async start(): Promise<void> {
    // Whatever was spawned before is stopped first — a server that is not
    // up cannot be asked to leave, so it is killed.
    this.dropChild();
    this.generation += 1;
    const generation = this.generation;
    const settings = this.opts.settings();
    const started = await startServer({
      command: settings.command,
      args: settings.args,
      cwd: this.opts.root,
      extensionVersion: this.opts.extensionVersion,
      spawn: this.opts.spawn,
      handshakeMs: this.opts.handshakeMs,
      onSpawn: (child) => {
        if (generation === this.generation) this.child = child;
      },
      onStatus: (status) => {
        if (generation !== this.generation) return;
        this.opts.store.dispatch({ kind: "server", status });
        if (status.kind !== "up" && status.kind !== "starting") {
          this.client = null;
          this.child = null;
        }
      },
      onNotification: (n) => {
        if (generation === this.generation) this.opts.onNotification(n);
      },
    });
    if (generation !== this.generation) {
      // A restart overtook this start: what it started is not ours to keep.
      if (started.client !== null && started.child !== null) void stopServer(started.client, started.child);
      else if (started.child !== null) killIfAlive(started.child);
      return;
    }
    this.client = started.client;
    this.child = started.child;
  }

  /** The live server asked to leave within `ceilingMs`; a server that never came up is killed outright. */
  async stop(ceilingMs = DEACTIVATE_CEILING_MS): Promise<void> {
    const { client, child } = this;
    this.client = null;
    this.child = null;
    if (client !== null && child !== null) await stopServer(client, child, ceilingMs);
    else if (child !== null) killIfAlive(child);
  }

  async restart(): Promise<void> {
    this.opts.store.dispatch({ kind: "server", status: { kind: "starting" } });
    await this.stop(this.opts.restartCeilingMs ?? STOP_CEILING_MS);
    await this.start();
  }

  private dropChild(): void {
    const child = this.child;
    this.client = null;
    this.child = null;
    if (child !== null) killIfAlive(child);
  }
}
