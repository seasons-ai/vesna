import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseStarter, writeStarterConfig } from "../../src/cli/init";
import { loadConfig } from "../../src/cli/config";
import { PRESETS } from "../../src/providers/catalog";
import { main } from "../../src/cli/main";
import { writeSettings, settingsPath } from "../../src/cli/settings";

async function home(files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vesna-init-home-"));
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  return dir;
}
const root = () => mkdtemp(join(tmpdir(), "vesna-init-"));
const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const live = () => jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });

test("a logged-in codex is chosen, because it costs nothing extra", async () => {
  const dir = await home({ ".codex/auth.json": JSON.stringify({ tokens: { access_token: live() } }) });
  expect(await chooseStarter({}, dir)).toEqual({ provider: "openai", auth: "codex" });
});

test("an anthropic key is chosen when there is no codex login", async () => {
  expect(await chooseStarter({ ANTHROPIC_API_KEY: "sk-ant" }, await home())).toEqual({
    provider: "anthropic",
    auth: "key",
  });
});

test("an openai key is chosen over nothing at all", async () => {
  expect(await chooseStarter({ OPENAI_API_KEY: "sk" }, await home())).toEqual({
    provider: "openai",
    auth: "key",
  });
});

test("codex wins over a stray key, since it is the cheaper path", async () => {
  const dir = await home({ ".codex/auth.json": JSON.stringify({ tokens: { access_token: live() } }) });
  expect(await chooseStarter({ ANTHROPIC_API_KEY: "sk-ant" }, dir)).toEqual({
    provider: "openai",
    auth: "codex",
  });
});

test("an expired codex login is not chosen — it would fail on first use", async () => {
  const dir = await home({ ".codex/auth.json": JSON.stringify({ tokens: { access_token: jwt({ exp: 1000 }) } }) });
  expect((await chooseStarter({}, dir)).auth).not.toBe("codex");
});

test("with nothing available it still writes something honest to edit", async () => {
  expect(await chooseStarter({}, await home())).toEqual({ provider: "anthropic", auth: "key" });
});

test("the file it writes is a config Vesna can actually read back", async () => {
  const dir = await root();
  await writeStarterConfig(dir, { provider: "openai", auth: "codex" });
  // An isolated, empty home: the real ~/.vesna/settings.yaml must not leak in.
  const config = await loadConfig(dir, {}, await home());
  expect(config.configured).toBe(true);
  expect(config.provider).toBe("openai");
  expect(config.auth).toBe("codex");
});

test("the file explains itself, so the next reader is not guessing", async () => {
  const dir = await root();
  await writeStarterConfig(dir, { provider: "openai", auth: "codex" });
  const text = await readFile(join(dir, ".vesna", "config.yaml"), "utf8");
  expect(text).toContain("#");
  expect(text).toContain("theme");
});

test("an existing config is never overwritten", async () => {
  const dir = await root();
  await mkdir(join(dir, ".vesna"), { recursive: true });
  await writeFile(join(dir, ".vesna", "config.yaml"), "provider: openai\n# mine\n");
  await expect(writeStarterConfig(dir, { provider: "anthropic", auth: "key" })).rejects.toThrow(
    /already exists/,
  );
  expect(await readFile(join(dir, ".vesna", "config.yaml"), "utf8")).toContain("# mine");
});

test("it returns the path it wrote, so the caller can say where", async () => {
  const dir = await root();
  const path = await writeStarterConfig(dir, { provider: "anthropic", auth: "key" });
  expect(path).toBe(join(dir, ".vesna", "config.yaml"));
});

// `writeStarterConfig` -> `loadConfig` -> `presetFor` round-trips back to the
// same preset id, given the correct id as input — for every catalog entry,
// driven from the catalog itself so a preset added later is covered without
// anyone remembering to add a case.
//
// This does NOT exercise the actual regression it was written alongside: the
// bug lived in `src/cli/main.ts`'s `init` action, in the choice of which
// value to pass as `provider` (the collapsed `earlyConfig.provider` versus
// the resolved `earlyConfig.preset.id`) — a call this loop never makes, since
// it supplies `preset.id` itself. See the `vesna init` end-to-end test below
// for the test that actually exercises that dispatch code and catches it.
for (const preset of PRESETS) {
  test(`pinning the "${preset.id}" preset round-trips back to itself`, async () => {
    const dir = await root();
    await writeStarterConfig(dir, {
      provider: preset.id,
      auth: preset.auth ?? "key",
      model: preset.model,
      baseUrl: preset.baseUrl,
      env: preset.env,
    });

    // An isolated, empty home: real machine-wide settings must not leak in
    // and silently paper over a pin that did not actually take.
    const config = await loadConfig(dir, {}, await home());
    expect(config.preset.id).toBe(preset.id);
  });
}

// The actual regression: `vesna init` (src/cli/main.ts's "init" action) must
// pin `earlyConfig.preset.id`, not the collapsed `earlyConfig.provider`. Both
// are legal strings ("ollama" vs "openai") so nothing but running the real
// dispatch catches a swap back to the wrong one — the loop above supplies
// `provider.id` itself and never touches this choice.
test("`vesna init` pins the resolved preset id, not the dialect it collapses onto (ollama, not openai)", async () => {
  const dir = await root();
  const vesnaHome = await mkdtemp(join(tmpdir(), "vesna-init-vhome-"));
  // Machine-wide settings resolve to ollama — same as if `/provider ollama`
  // had been run earlier. `VESNA_HOME` makes this independent of the real
  // home directory, and independent of any real ~/.vesna/settings.yaml.
  writeSettings(settingsPath({ VESNA_HOME: vesnaHome }, vesnaHome), { provider: "ollama" });

  const previousCwd = process.cwd();
  const previousVesnaHome = process.env.VESNA_HOME;
  const previousLog = console.log;
  process.chdir(dir);
  process.env.VESNA_HOME = vesnaHome;
  console.log = () => {}; // silence `vesna init`'s own report for this test
  let exitCode: number;
  try {
    exitCode = await main(["init"]);
  } finally {
    console.log = previousLog;
    process.chdir(previousCwd);
    if (previousVesnaHome === undefined) delete process.env.VESNA_HOME;
    else process.env.VESNA_HOME = previousVesnaHome;
  }

  expect(exitCode).toBe(0);
  const config = await loadConfig(dir, { VESNA_HOME: vesnaHome }, vesnaHome);
  expect(config.preset.id).toBe("ollama");
});

// `vesna init` on a subscription setup wrote "No key needed for this endpoint",
// which is the one thing that is not true of it: it needs an oauth block, and
// this file is the only place one can go.
test("pinning the subscription preset writes what it actually needs", async () => {
  const dir = await root();
  await writeStarterConfig(dir, { provider: "subscription", auth: "subscription" });
  const text = await readFile(join(dir, ".vesna", "config.yaml"), "utf8");
  expect(text).not.toContain("No key needed");
  expect(text).toContain("oauth");
  expect(text).toContain("clientId");
});
