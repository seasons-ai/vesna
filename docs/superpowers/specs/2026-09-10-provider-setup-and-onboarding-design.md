# Provider setup and onboarding

Status: approved, not yet implemented
Date: 2026-09-10

## The problem

Vesna is installable now, so the first five minutes belong to strangers rather
than to the person who wrote it. Those five minutes currently go:

```
$ npm install -g @seasons-ai/vesna
$ vesna
vesna: unknown command "undefined"
```

Four things are wrong, and they are one thing.

**Nothing happens when you run the program.** The bare command prints usage for
a program you have not configured. `vesna chat` is the thing people want, and it
is the one word they have no reason to guess.

**Settings are per-folder.** `provider` and `model` live in
`.vesna/config.yaml` inside the project, so every new directory is a fresh
setup. What model you talk to is a property of your machine and your
subscription, not of a repository.

**Providers are dialects, not products.** The config offers `anthropic` and
`openai`, which are wire formats. OpenRouter, Groq, Ollama, LM Studio, vLLM and
any local server are all the openai dialect with a different `baseUrl`, key
variable and default model — but you have to know that, and know that `baseUrl`
is accepted at all, before you can connect one.

**Nothing can be changed from inside the conversation.** Switching model means
leaving, editing YAML, and coming back.

## Decisions

### 1. Two settings files, one of them Vesna's

`~/.vesna/settings.yaml` is written by Vesna. `.vesna/config.yaml` is written
by a person and is never rewritten — the rule `/theme` already follows, for the
reason it already gives: rewriting someone's config costs them their comments
and their layout. `.vesna/permissions.yaml` established the other half of this
boundary; provider settings join it.

Precedence, highest first:

1. a command-line flag (`--model`)
2. `.vesna/config.yaml` in the project
3. `~/.vesna/settings.yaml`
4. the built-in default

`VesnaConfig.configured` changes meaning: today it reports whether a project
file was found, and it will report whether there is anything to work with. The
old meaning has no callers once a global file can supply everything.

**A pinned project must not make the command lie.** When `provider` is set in
the project config, `/provider ollama` cannot take effect in this directory. It
then changes the global default and says so:

```
provider: ollama  (global default)
this project pins anthropic in .vesna/config.yaml — unchanged here
```

Silently doing nothing is the worse failure: the user sees a command succeed
and a setting not change, and has no way to connect the two.

### 2. A catalog of presets

`src/providers/catalog.ts`, data rather than code:

```ts
{ id: "openrouter", dialect: "openai", baseUrl: "https://openrouter.ai/api/v1",
  env: "OPENROUTER_API_KEY", model: "anthropic/claude-sonnet-5" }
```

Shipped presets: `anthropic`, `openai`, `codex`, `openrouter`, `groq`,
`ollama`, `lmstudio`, `vllm`, `custom`.

`provider:` becomes the name of a preset. What it used to name — the wire
dialect — moves inside the preset as a field, where it belongs: it is an
implementation fact about a service, not a choice a user makes.

Existing configs keep working unchanged, because `anthropic` and `openai` are
themselves presets under those names.

`custom` asks for a base URL and a credential. The URL goes to
`settings.yaml`; the credential goes where every other credential goes, and
never into the settings file — see Non-goals. Adding a named service later is a
catalog entry, not a code change.

### 3. `/provider` and `/model`

`/provider` with no argument lists the catalog, marking the current one and
whether a credential for it was found. `/provider <id>` switches.

`/model` with no argument lists models. For `codex` and `anthropic` the list is
built in. For openai-compatible endpoints it asks the endpoint itself with
`GET /v1/models` — a question to a service already configured and already being
talked to, not a scan of the machine.

Both write to `~/.vesna/settings.yaml`, so a choice made once in a conversation
holds for the next one.

### 4. Switching provider mid-conversation

`buildContext` returns a `ProviderHandle` — `{ current, switch(preset, model) }`
— instead of a bare provider. The TUI holds one reference, and the session,
transcript, spec and store survive the switch.

Two alternatives were considered and rejected. Rebuilding the whole context is
simpler but destroys the registry, the spec sink and everything the session has
accumulated, which is a large cost for a small feature. Passing `() => Provider`
everywhere spreads late binding across every signature to make one point
mutable.

History carries across intact, and this was checked rather than assumed.
`ContentBlock` in `providers/types.ts` is Vesna's own neutral shape: providers
translate to their dialect at the edge, tool-call identifiers are opaque
pass-through strings in all three, and reasoning never enters history because
no such block type exists. So there is nothing to translate and nothing to
lose.

One hazard is real. An unpaired tool call — an assistant asking for a tool with
no result after it, which is what an interrupt mid-tool leaves behind — is
rejected by both APIs. Those are dropped, and only those. The transcript
reports a loss only when there was one:

```
switched to ollama/qwen3 · dropped 1 unanswered tool call
```

Dropping every tool call, as this design first said, would have been
precaution against a problem the neutral representation already solved.

### 5. Onboarding

Runs when there is nothing to work with — not behind a command you would have
to know exists.

Three steps: choose a preset from the catalog (annotated with credentials
already found on the machine, e.g. `key found in $GROQ_API_KEY`), supply a key
or sign in if needed, then **make a real call**.

The verification step is the point. This codebase already refuses to accept a
claim as a fact: `task_verify` will not mark a task done on the agent's word, it
runs a command and reads the exit status. An onboarding that writes a file and
announces success without ever reaching a model tells the user the same kind of
lie. One short call, reporting the model that answered and how long it took.

It writes `~/.vesna/settings.yaml` and touches no project directory. Nothing
needs to exist in a folder before you can work in it.

### 6. The bare command

`vesna` with no arguments opens the chat TUI when there is something to work
with, and runs onboarding when there is not — continuing into the chat in the
same process afterwards, rather than instructing the user to run another
command.

`vesna chat` stays as an explicit alias. `--plain` and non-TTY behaviour are
unchanged.

An unrecognised first word stays an error. Treating it as a task would mean a
mistyped command silently starts work nobody asked for.

### 7. What `init` becomes

`vesna init` keeps its name and changes its meaning: it pins the current
effective settings to this repository, writing a project config a team can
commit. That is what it is actually for once machine-wide settings exist. Its
usage line says so.

## Non-goals

- No port scanning for local servers. Network probes at startup that nobody
  asked for are a surprise, and the catalog plus `custom` covers the case.
- No secrets in `settings.yaml`. It records the *name* of an environment
  variable; keys and tokens stay in `~/.vesna/auth.json` and the environment.
- No third wire dialect. Every service added here speaks one of the two.

## Testing

Test-first throughout.

- **Precedence** — a table of source combinations against the expected
  effective config, including the flag and the built-in default.
- **Catalog** — every shipped preset resolves to a valid request shape.
- **Pinned project** — `/provider` with a project-pinned provider changes the
  global file and reports that it did not change this directory.
- **Switch** — a history of five messages containing two `tool_use` blocks
  produces text-only history and a dropped count of exactly 2.
- **Onboarding** — a clean `HOME` runs it; a second run does not; the written
  file is the one the next run reads.
- **Bare command** — configured goes to chat, unconfigured goes to onboarding,
  unknown word is still an error.

## Files

New: `src/cli/settings.ts`, `src/cli/onboard.ts`, `src/providers/catalog.ts`.

Changed: `src/cli/main.ts` (dispatch), `src/cli/config.ts` (precedence),
`src/cli/init.ts` (new meaning), `src/cli/chatcmd.ts` (two commands),
`src/tui/app.ts` (handlers), `src/cli/context.ts` (`ProviderHandle`).

Also moved: `authCommand` leaves `main.ts` for `src/cli/authcmd.ts`. It is 130
lines of one function inside an already overloaded dispatcher, and this work
edits both.
