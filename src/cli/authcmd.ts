import { homedir } from "node:os";
import { browserLogin } from "../auth/login";
import { authPath, saveAuth } from "../auth/store";
import { inspectCredential, problem, remedy, usable } from "./preflight";
import { createStdioPrompt } from "../tui/stdio";
import { EXIT } from "./exit";
import type { VesnaConfig } from "./config";
import type { Theme } from "../tui/theme";

/**
 * The auth command, which is a screenful of reporting rather than a branch.
 *
 * It lived in main.ts, where 130 lines of one function sat between the
 * dispatcher and the commands it dispatches to. Nothing else about it changes.
 */
export async function authCommand(
  target: string | undefined,
  config: VesnaConfig,
  theme: Theme,
  root: string,
): Promise<number> {
  if (target === "login") {
    if (config.provider !== "openai" || !config.oauth) {
      console.log("Sign-in applies to the openai provider with an oauth block configured.");
      console.log(theme.paint("muted", "  provider: openai"));
      console.log(theme.paint("muted", "  auth: subscription"));
      console.log(theme.paint("muted", "  oauth: { issuer, clientId, baseUrl }"));
      return EXIT.error;
    }

    const io = createStdioPrompt();
    try {
      console.log(theme.paint("text", "How would you like to sign in?"));
      console.log(`  ${theme.paint("petal", "1")}  browser      opens ${config.oauth.issuer}`);
      console.log(`  ${theme.paint("petal", "2")}  headless     print the URL to open elsewhere`);
      console.log(`  ${theme.paint("petal", "3")}  API key      paste a key instead`);
      const choice = (await io.question("\n  choice [1]: ")).trim() || "1";

      if (choice === "3") {
        const key = (await io.question("  API key: ")).trim();
        if (key === "") {
          console.error("no key entered");
          return EXIT.error;
        }
        const path = authPath(process.env, homedir());
        await saveAuth(path, { provider: "openai", accessToken: key });
        console.log(theme.paint("ok", `\nSaved to ${path}`));
        return EXIT.ok;
      }

      const headless = choice === "2";
      const auth = await browserLogin(
        {
          issuer: config.oauth.issuer,
          clientId: config.oauth.clientId,
          provider: "openai",
          scope: config.oauth.scope,
        },
        {
          async openBrowser(url) {
            if (headless) {
              console.log(theme.paint("muted", "\n  open this on any machine with a browser:\n"));
              console.log(`  ${url}\n`);
              return;
            }
            console.log(theme.paint("muted", "\n  opening your browser…"));
            Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
          },
        },
      );

      const path = authPath(process.env, homedir());
      await saveAuth(path, auth);
      console.log(theme.paint("ok", `\nSigned in. Saved to ${path}`));
      return EXIT.ok;
    } finally {
      io.close();
    }
  }

  {
    // The preset's id, not `config.provider`: that field is the wire dialect,
    // and it reads "openai" for Groq, OpenRouter, Ollama and OpenAI alike.
    console.log(`provider:   ${theme.paint("petal", config.preset.id)}  model ${config.model}`);
    console.log(theme.paint("muted", `            ${config.preset.label}`));

    const credential = await inspectCredential(config, process.env, homedir());

    if (credential.mode === "codex") {
      console.log(`endpoint:   ${credential.endpoint}`);
      if (credential.state === "missing") {
        console.log(`credential: ${theme.paint("warn", "no codex subscription token")}`);
      } else {
        const state =
          credential.state === "expired"
            ? theme.paint("warn", "expired — run `codex login`")
            : theme.paint("ok", "valid");
        console.log(`credential: borrowed from codex  ${state}`);
        console.log(theme.paint("muted", `            ${credential.path} (read-only)`));
      }
    } else if (credential.mode === "subscription") {
      console.log(`endpoint:   ${credential.endpoint ?? theme.paint("warn", "not configured")}`);
      if (credential.state === "missing") {
        console.log(`credential: ${theme.paint("warn", "not signed in")}`);
      } else {
        const state =
          credential.state === "expired"
            ? theme.paint("warn", "expired — will refresh on next use")
            : theme.paint("ok", "valid");
        console.log(`credential: subscription token  ${state}`);
        console.log(theme.paint("muted", `            ${credential.path}`));
      }
    } else if (credential.mode === "openai-key") {
      console.log(`endpoint:   ${credential.endpoint}`);
      if (credential.state === "valid") {
        console.log(
          credential.reason === "local"
            ? `credential: ${theme.paint("ok", "none needed")} ${theme.paint("muted", "(local endpoint)")}`
            : `credential: ${theme.paint("ok", credential.env ?? "OPENAI_API_KEY")}`,
        );
      } else {
        console.log(`credential: ${theme.paint("warn", "none")}`);
      }
    } else {
      const { source, dir, profiles } = credential;
      const label =
        source.kind === "profile"
          ? theme.paint("ok", `OAuth profile "${source.profile}"`)
          : source.kind === "api_key"
            ? theme.paint("ok", "ANTHROPIC_API_KEY")
            : source.kind === "auth_token"
              ? theme.paint("ok", "ANTHROPIC_AUTH_TOKEN")
              : theme.paint("warn", "none");

      console.log(`credential: ${label}`);
      console.log(theme.paint("muted", `            ${source.note}`));
      console.log(
        theme.paint("muted", `profiles:   ${profiles.length > 0 ? profiles.join(", ") : "none"} (${dir})`),
      );
    }

    // The status command and the check before a conversation share one verdict,
    // so they can never tell the user two different things.
    if (usable(credential)) return EXIT.ok;

    console.log("");
    console.log(theme.paint("warn", problem(credential)));
    for (const line of remedy(config, credential)) console.log(line);
    return EXIT.error;
  }
}
