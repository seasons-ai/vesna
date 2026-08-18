import { test, expect } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authPath, isExpired, loadAuth, saveAuth } from "../../src/auth/store";

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "vesna-auth-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const auth = { provider: "openai", accessToken: "at", refreshToken: "rt", expiresAt: 1 };

test("credentials live outside the project directory", () => {
  const path = authPath({}, "/home/u");
  expect(path).toBe("/home/u/.config/vesna/auth.json");
  expect(path).not.toContain(".vesna/");
});

test("XDG_CONFIG_HOME is honoured", () => {
  expect(authPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe("/xdg/vesna/auth.json");
});

test("the file is written owner-only", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "auth.json");
    await saveAuth(path, auth);
    const mode = (await stat(path)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

test("saved credentials load back intact", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "auth.json");
    await saveAuth(path, auth);
    expect(await loadAuth(path)).toEqual(auth);
  });
});

test("a missing file is null rather than an error", async () => {
  await withDir(async (dir) => {
    expect(await loadAuth(join(dir, "nothing.json"))).toBeNull();
  });
});

test("a corrupt file is null rather than a crash on every command", async () => {
  await withDir(async (dir) => {
    const path = join(dir, "auth.json");
    await Bun.write(path, "{ not json");
    expect(await loadAuth(path)).toBeNull();
  });
});

test("expiry is judged with a margin, so a token does not die mid-request", () => {
  const now = 1_000_000;
  expect(isExpired({ ...auth, expiresAt: now + 300_000 }, now)).toBe(false);
  expect(isExpired({ ...auth, expiresAt: now + 10_000 }, now)).toBe(true);
  expect(isExpired({ ...auth, expiresAt: now - 1 }, now)).toBe(true);
});

test("a token with no stated expiry is treated as still valid", () => {
  expect(isExpired({ provider: "openai", accessToken: "at" }, Date.now())).toBe(false);
});
