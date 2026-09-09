import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseStarter, writeStarterConfig } from "../../src/cli/init";
import { loadConfig } from "../../src/cli/config";

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
  const config = await loadConfig(dir);
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
