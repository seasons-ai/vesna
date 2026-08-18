import type { ProposedParameter } from "../crystallize/propose";
import type { Theme } from "./theme";

export interface PromptIO {
  write(text: string): void;
  question(prompt: string): Promise<string>;
}

export interface ConfirmOptions {
  /** When false, every suggestion is accepted without asking — for scripts and CI. */
  interactive?: boolean;
}

/**
 * Walks the proposed parameters with a human. Returns a map of suggested name to
 * the name actually chosen, so a rename is carried through to the flow.
 */
export async function confirmParameters(
  parameters: ProposedParameter[],
  io: PromptIO,
  theme: Theme,
  options: ConfirmOptions = {},
): Promise<Map<string, string>> {
  const accepted = new Map<string, string>();
  if (parameters.length === 0) return accepted;

  const interactive = options.interactive ?? true;
  if (!interactive) {
    for (const parameter of parameters) {
      accepted.set(parameter.suggestedName, parameter.suggestedName);
    }
    return accepted;
  }

  io.write(theme.paint("label", "Which literals are really parameters?"));
  io.write(theme.paint("dim", "  enter = accept · n = skip · anything else = rename"));
  io.write("");

  for (const parameter of parameters) {
    const sites = parameter.sites.map((site) => `${site.nodeId}.${site.field}`).join(", ");
    io.write(`  ${theme.paint("accent", `"${parameter.literal}"`)}  ${theme.paint("dim", `at ${sites}`)}`);

    const answer = (await io.question(`    input name [${parameter.suggestedName}]: `)).trim();
    if (answer.toLowerCase() === "n") {
      io.write(theme.paint("dim", "    skipped"));
      io.write("");
      continue;
    }

    const name = answer === "" ? parameter.suggestedName : answer;
    accepted.set(parameter.suggestedName, name);
    io.write(theme.paint("ok", `    -> $.inputs.${name}`));
    io.write("");
  }

  return accepted;
}
