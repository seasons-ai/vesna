import { test, expect } from "bun:test";
import { clipboardCommand, copyToClipboard, osc52 } from "../../src/tui/clipboard";

test("macOS uses pbcopy", () => {
  expect(clipboardCommand("darwin", {})).toEqual(["pbcopy"]);
});

test("Wayland is preferred over X11 when the session says so", () => {
  expect(clipboardCommand("linux", { WAYLAND_DISPLAY: "wayland-0" })).toEqual(["wl-copy"]);
});

test("X11 falls back to xclip, asking for the clipboard rather than the primary selection", () => {
  expect(clipboardCommand("linux", { DISPLAY: ":0" })).toEqual([
    "xclip",
    "-selection",
    "clipboard",
  ]);
});

test("Windows uses clip", () => {
  expect(clipboardCommand("win32", {})).toEqual(["clip.exe"]);
});

test("a headless Linux session has no command, and must fall back", () => {
  expect(clipboardCommand("linux", {})).toBeUndefined();
});

test("the OSC 52 sequence carries the text base64-encoded to the clipboard target", () => {
  const sequence = osc52("hi");
  expect(sequence).toBe(`\x1b]52;c;${Buffer.from("hi").toString("base64")}\x07`);
});

test("OSC 52 survives a round trip through non-ascii text", () => {
  const text = "привет — ok";
  const encoded = /;c;([^\x07]*)\x07$/.exec(osc52(text))![1]!;
  expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(text);
});

test("a working command is used, and the text reaches its stdin", async () => {
  let got: { argv: string[]; input: string } | undefined;
  const result = await copyToClipboard("hello", {
    platform: "darwin",
    env: {},
    run: async (argv, input) => {
      got = { argv, input };
      return true;
    },
    write: () => {},
  });
  expect(result).toBe("command");
  expect(got).toEqual({ argv: ["pbcopy"], input: "hello" });
});

test("when the command fails the escape sequence is tried instead", async () => {
  let written = "";
  const result = await copyToClipboard("hello", {
    platform: "darwin",
    env: {},
    run: async () => false,
    write: (text) => {
      written += text;
    },
  });
  expect(result).toBe("osc52");
  expect(written).toBe(osc52("hello"));
});

test("with no command at all it goes straight to the escape sequence", async () => {
  let written = "";
  const result = await copyToClipboard("x", {
    platform: "linux",
    env: {},
    run: async () => {
      throw new Error("must not be called");
    },
    write: (text) => {
      written += text;
    },
  });
  expect(result).toBe("osc52");
  expect(written).toBe(osc52("x"));
});

test("copying nothing is refused rather than silently clearing the clipboard", async () => {
  let touched = false;
  const result = await copyToClipboard("   ", {
    platform: "darwin",
    env: {},
    run: async () => {
      touched = true;
      return true;
    },
    write: () => {
      touched = true;
    },
  });
  expect(result).toBe("empty");
  expect(touched).toBe(false);
});

test("text too large for an escape sequence still goes through a real command", async () => {
  const huge = "x".repeat(200_000);
  const result = await copyToClipboard(huge, {
    platform: "darwin",
    env: {},
    run: async () => true,
    write: () => {},
  });
  expect(result).toBe("command");
});

test("text too large for an escape sequence, with no command, is refused honestly", async () => {
  let written = "";
  const result = await copyToClipboard("x".repeat(200_000), {
    platform: "linux",
    env: {},
    run: async () => false,
    write: (text) => {
      written += text;
    },
  });
  expect(result).toBe("too-large");
  expect(written).toBe("");
});
