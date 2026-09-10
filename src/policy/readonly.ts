/**
 * Whether a shell command only looks.
 *
 * A node declares its worst case: `shell` can do anything, so it is a write.
 * But a particular command's effect is visible in the command itself, and
 * asking permission to run `ls` teaches the user to stop reading the question
 * — which costs far more than it saves the first time something real appears.
 *
 * Conservative by construction. Anything not recognised asks, because a false
 * "safe" is silent and permanent while an extra question is merely annoying.
 */

/** Commands that read and print. None of them can write without redirection. */
const READS = new Set([
  "ls",
  "pwd",
  "cat",
  "bat",
  "head",
  "tail",
  "wc",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "find",
  // sed prints unless asked to edit in place, and -i is refused below.
  "sed",
  "file",
  "stat",
  "du",
  "df",
  "date",
  "echo",
  "printf",
  "basename",
  "dirname",
  "realpath",
  "which",
  "type",
  "whoami",
  "hostname",
  "uname",
  "sort",
  "uniq",
  "cut",
  "tr",
  "column",
  "jq",
  "yq",
  "tree",
  "diff",
  "cmp",
  "md5",
  "shasum",
  "true",
  "false",
]);

/** git is a whole toolbox; only the reading half is safe. */
const GIT_READS = new Set([
  "status",
  "log",
  "diff",
  "show",
  "branch",
  "blame",
  "describe",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "shortlog",
  "tag",
  "remote",
  "stash",
  "whatchanged",
  "cat-file",
  "grep",
]);

/** Flags that turn a reader into a writer. */
const WRITING_FLAGS = new Map<string, string[]>([
  ["find", ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fls"]],
  ["git", ["-d", "-D", "--delete", "--prune", "--force"]],
  ["sort", ["-o", "--output"]],
  ["shasum", ["-w"]],
]);

/** Subcommands of an otherwise-reading command that write. */
const WRITING_SUBCOMMANDS = new Map<string, string[]>([
  ["git", ["push", "pull", "commit", "add", "rm", "reset", "checkout", "merge", "rebase"]],
  ["stash", ["push", "pop", "apply", "drop", "clear", "save"]],
]);

/**
 * Anything that can send output somewhere, run something else, or expand into
 * another command. A read-only command with a redirection is a write.
 */
const DANGEROUS = /[><`$(){}\\]|\|\||&/;

export function isReadOnlyCommand(command: string): boolean {
  const text = command.trim();
  if (text === "") return false;
  if (DANGEROUS.test(text)) return false;

  // A pipeline is safe only if every stage is, and `;` and `&&` are gone with
  // the check above, so the only separator left to split on is the pipe.
  const stages = text.split("|");
  if (stages.some((stage) => stage.trim() === "")) return false;

  return stages.every((stage) => stageReads(stage.trim()));
}

function stageReads(stage: string): boolean {
  const words = stage.split(/\s+/).filter((word) => word !== "");
  const head = words[0];
  if (head === undefined) return false;

  // A path to a binary is not a name we can reason about.
  if (head.includes("/")) return false;
  if (!READS.has(head) && head !== "git") return false;

  const rest = words.slice(1);

  if (head === "git") {
    const subcommand = rest.find((word) => !word.startsWith("-"));
    if (subcommand === undefined || !GIT_READS.has(subcommand)) return false;
    const after = rest.slice(rest.indexOf(subcommand) + 1).find((word) => !word.startsWith("-"));
    if (WRITING_SUBCOMMANDS.get(subcommand)?.includes(after ?? "")) return false;
  }

  const banned = WRITING_FLAGS.get(head) ?? [];
  if (rest.some((word) => banned.includes(word))) return false;

  // In-place editing turns any reader into a writer, whatever it is called.
  if (rest.some((word) => word === "-i" || word.startsWith("--in-place"))) return false;

  return true;
}
