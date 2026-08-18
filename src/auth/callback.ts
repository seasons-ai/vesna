export interface CallbackPageState {
  ok: boolean;
  message: string;
}

export type CallbackResult =
  | { ok: true; code: string; state: string | null }
  | { ok: false; error: string };

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The page the browser lands on after the redirect. It is the only part of Vesna
 * a user sees in a browser, so it says what happened and that they can leave.
 * The message is escaped: it can carry text from the redirect, which is not ours.
 */
export function renderCallbackPage(state: CallbackPageState): string {
  const title = state.ok ? "Signed in" : "Sign-in failed";
  const accent = state.ok ? "#4f9d69" : "#c96442";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vesna — ${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #faf9f7; --fg: #1c1b19; --dim: #6b6864; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #16181a; --fg: #eceae7; --dim: #8d8a86; }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: var(--bg); color: var(--fg);
    font: 15px/1.6 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  }
  main { max-width: 26rem; padding: 2.5rem; text-align: center; }
  .mark { width: 2.5rem; height: 2.5rem; margin: 0 auto 1.25rem; border-radius: 50%;
          background: ${accent}; display: grid; place-items: center; color: #fff; font-size: 1.1rem; }
  h1 { margin: 0 0 .5rem; font-size: 1.35rem; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0 0 .35rem; }
  .detail { color: var(--dim); word-break: break-word; }
  .hint { margin-top: 1.5rem; color: var(--dim); font-size: .875rem; }
</style>
</head>
<body>
  <main>
    <div class="mark">${state.ok ? "&check;" : "!"}</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="detail">${escapeHtml(state.message)}</p>
    <p class="hint">You can close this tab and return to your terminal.</p>
  </main>
</body>
</html>`;
}

export interface CallbackServer {
  port: number;
  redirectUri: string;
  result: Promise<CallbackResult>;
  close(): void;
}

/**
 * A one-shot loopback listener for an OAuth redirect. Binds an ephemeral port so
 * several sign-ins cannot collide, and resolves as soon as the browser arrives.
 */
export function startCallbackServer(): CallbackServer {
  let settle: (result: CallbackResult) => void = () => {};
  const result = new Promise<CallbackResult>((resolve) => {
    settle = resolve;
  });

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");

      if (error !== null) {
        settle({ ok: false, error });
        return new Response(renderCallbackPage({ ok: false, message: error }), {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      if (code === null) {
        return new Response(
          renderCallbackPage({ ok: false, message: "the redirect carried no authorisation code" }),
          { status: 400, headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }

      settle({ ok: true, code, state: url.searchParams.get("state") });
      return new Response(renderCallbackPage({ ok: true, message: "Vesna is signed in." }), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  const port = server.port ?? 0;
  return {
    port,
    redirectUri: `http://localhost:${port}/callback`,
    result,
    close: () => server.stop(true),
  };
}
