const ESC = "";
const RESET = `${ESC}[0m`;

/** 256-colour foreground code. Widely supported, and safer than truecolour. */
function fg(code: number): string {
  return `${ESC}[38;5;${code}m`;
}

export type Role = "ok" | "held" | "dim" | "accent" | "label";

export interface ThemeDefinition {
  name: string;
  roles: Record<Role, string>;
}

export const THEMES: Record<string, ThemeDefinition> = {
  vesna: {
    name: "vesna",
    roles: { ok: fg(78), held: fg(215), dim: fg(245), accent: fg(114), label: fg(252) },
  },
  ember: {
    name: "ember",
    roles: { ok: fg(180), held: fg(203), dim: fg(240), accent: fg(209), label: fg(223) },
  },
  dusk: {
    name: "dusk",
    roles: { ok: fg(110), held: fg(176), dim: fg(243), accent: fg(147), label: fg(252) },
  },
  mono: {
    name: "mono",
    roles: { ok: "", held: "", dim: "", accent: "", label: "" },
  },
};

const DEFAULT_THEME = "vesna";

/**
 * Honours the NO_COLOR convention first, then FORCE_COLOR, then whether stdout
 * is a terminal. Piped output and CI logs must stay free of escape codes.
 */
export function colorSupported(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0") {
    return true;
  }
  return isTTY;
}

export interface Theme {
  name: string;
  paint(role: Role, text: string): string;
}

export function resolveTheme(name: string | undefined, options: { color: boolean }): Theme {
  const definition = (name && THEMES[name]) || THEMES[DEFAULT_THEME]!;
  return {
    name: definition.name,
    paint(role, text) {
      const code = definition.roles[role];
      if (!options.color || code === "") return text;
      return `${code}${text}${RESET}`;
    },
  };
}
