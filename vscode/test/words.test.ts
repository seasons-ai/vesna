import { test, expect } from "bun:test";
import { WORDS, NEXT_MODE, COMMAND_NAMES } from "../src/words";

test("the words a person sees are exact", () => {
  expect(WORDS.allowOnce).toBe("Allow once");
  expect(WORDS.tooOld("0.7.0", "0.1.0")).toBe("This Vesna (0.7.0) is too old for this extension (0.1.0).");
  expect(WORDS.exited(null)).toBe("Vesna exited.");
  expect(WORDS.exited(2)).toBe("Vesna exited with code 2.");
  expect(WORDS.statusBuilding("T2")).toBe("vesna: building T2");
  expect(NEXT_MODE.auto).toBe("plan");
  expect(COMMAND_NAMES).not.toContain("theme");
});
