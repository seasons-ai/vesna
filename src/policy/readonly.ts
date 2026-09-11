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
 * The reviewer's gate turns a "no" here into a refusal rather than a question,
 * so every "yes" below has to be one that cannot write, run or change a repo.
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
  // sed prints unless its script writes; the script is checked below.
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

/**
 * Flags that turn a reader into a writer: an output file, an in-place edit,
 * or a program the tool runs on its own behalf.
 */
const WRITING_FLAGS = new Map<string, string[]>([
  ["find", ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]],
  ["sort", ["-o", "--output", "--compress-program"]],
  ["shasum", ["-w"]],
  ["tree", ["-o"]],
  ["yq", ["-i", "--inplace", "-s", "--split-exp"]],
  // --pre runs a command on every file it searches.
  ["rg", ["--pre"]],
  ["ag", ["--pager"]],
  ["bat", ["--pager"]],
  // -C compiles a magic file next to the source.
  ["file", ["-C", "--compile"]],
  ["date", ["-s", "--set"]],
]);

/**
 * git flags that write whatever the subcommand: an output file for the diff
 * family, a pager git grep runs per hit, and the deletion forms.
 */
const GIT_WRITING_FLAGS = ["-d", "-D", "--delete", "--prune", "--force", "-o", "--output", "-O", "--open-files-in-pager"];

/**
 * `branch` and `tag` list when given nothing, and create, move or retarget
 * when given a name. `remote` likewise. Each gets its own reading forms
 * rather than a deny-list, because the default action is the write.
 */
const BRANCH_WRITING_FLAGS = ["-m", "-M", "-c", "-C", "-f", "-u", "-t", "--move", "--copy", "--set-upstream-to", "--unset-upstream", "--edit-description", "--track"];
const TAG_WRITING_FLAGS = ["-a", "-s", "-u", "-m", "-F", "-f", "-e", "--annotate", "--sign", "--local-user", "--message", "--file", "--edit", "--cleanup", "--trailer", "--create-reflog"];
/** Listing flags whose value is the next word, so that word is not a name. */
const LISTING_VALUE_FLAGS = ["--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--sort", "--format"];
const REMOTE_READS = new Set(["show", "get-url"]);

/**
 * `git stash` alone behaves like `git stash push`: it moves working-tree
 * changes into the stash, which is a write. Unlike the rest of GIT_READS,
 * "stash" is not safe by default, so it gets an allow-list of its own instead
 * of a deny-list — anything not named here, including no subcommand at all,
 * is treated as the write it defaults to being.
 */
const STASH_READS = new Set(["list", "show"]);

/**
 * uniq's second operand is its output file. These flags take the next word
 * as a value, so that word is not an operand.
 */
const UNIQ_VALUE_FLAGS = ["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"];

/**
 * Anything that can send output somewhere, run something else, expand into
 * another command, or chain into a second command. A read-only command with
 * a redirection, a `;`, or an embedded newline is a write once a real shell
 * gets hold of it.
 */
const DANGEROUS = /[><`$(){}\\;\n\r]|\|\||&/;

export function isReadOnlyCommand(command: string): boolean {
  const text = command.trim();
  if (text === "") return false;
  if (DANGEROUS.test(text)) return false;

  // A pipeline is safe only if every stage is, and `;`, `&&` and newlines are
  // gone with the check above, so the only separator left to split on is the
  // pipe.
  const stages = text.split("|");
  if (stages.some((stage) => stage.trim() === "")) return false;

  return stages.every((stage) => stageReads(stage.trim()));
}

function stageReads(stage: string): boolean {
  const words = tokenize(stage);
  if (words === null) return false;
  const head = words[0];
  if (head === undefined) return false;

  // A path to a binary is not a name we can reason about.
  if (head.includes("/")) return false;
  if (!READS.has(head) && head !== "git") return false;

  const rest = words.slice(1);

  if (head === "git") return gitReads(rest);

  const banned = WRITING_FLAGS.get(head) ?? [];
  if (rest.some((word) => banned.some((flag) => matchesFlag(word, flag)))) return false;

  if (head === "sed") return sedReads(rest);
  if (head === "uniq") return operandsOf(rest, UNIQ_VALUE_FLAGS).length <= 1;
  // `hostname <name>` sets it.
  if (head === "hostname") return operandsOf(rest, []).length === 0;

  return true;
}

/**
 * The words the shell would hand the command. Quotes group and are stripped,
 * so `'-o'` is the flag `-o` and `'w out'` is one word. Backslashes and every
 * expansion are refused before this runs, so a quote is the only thing to
 * handle; an unterminated one is not a command that can be reasoned about.
 */
function tokenize(stage: string): string[] | null {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (const char of stage) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += char;
      inWord = true;
    }
  }
  if (quote !== null) return null;
  if (inWord) words.push(current);
  return words;
}

function gitReads(rest: string[]): boolean {
  const index = rest.findIndex((word) => !word.startsWith("-"));
  if (index === -1) return false;

  // Global options sit before the subcommand and reach into how it runs:
  // `-c diff.external=<program>` makes `git diff` execute the program, `-p`
  // forces a pager, `--exec-path` chooses where helpers come from. Only
  // `--no-pager` is harmless enough to keep.
  if (rest.slice(0, index).some((word) => word !== "--no-pager")) return false;

  const subcommand = rest[index]!;
  if (!GIT_READS.has(subcommand)) return false;
  const args = rest.slice(index + 1);

  if (args.some((word) => GIT_WRITING_FLAGS.some((flag) => matchesFlag(word, flag)))) return false;

  switch (subcommand) {
    case "stash":
      return STASH_READS.has(operandsOf(args, [])[0] ?? "");
    case "branch":
    case "tag": {
      const banned = subcommand === "branch" ? BRANCH_WRITING_FLAGS : TAG_WRITING_FLAGS;
      if (args.some((word) => banned.some((flag) => matchesFlag(word, flag)))) return false;
      // A name creates; a pattern under --list only filters.
      const lists = args.includes("--list") || args.includes("-l");
      return lists || operandsOf(args, LISTING_VALUE_FLAGS).length === 0;
    }
    case "remote": {
      const action = operandsOf(args, [])[0];
      return action === undefined || REMOTE_READS.has(action);
    }
    default:
      return true;
  }
}

/**
 * The words that are neither a flag nor the value of a flag in `valueFlags`
 * (matched exactly; the `=` form carries its value in the same word). A lone
 * `-` is stdin, which is an operand. `--` ends the flags.
 */
function operandsOf(args: string[], valueFlags: string[]): string[] {
  const operands: string[] = [];
  let flagsEnded = false;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i]!;
    if (flagsEnded || word === "-" || !word.startsWith("-")) {
      operands.push(word);
    } else if (word === "--") {
      flagsEnded = true;
    } else if (valueFlags.includes(word)) {
      i += 1;
    }
  }
  return operands;
}

/**
 * sed reads only when every script it is given is one of a small set of
 * commands that print, delete, substitute or transliterate. The `w` command
 * and the `w` flag of `s` write a file, `e` runs a command, and a script in
 * a file (-f) cannot be seen at all. In-place editing (-i) is a write
 * whatever the script.
 *
 * `;`, `{`, newlines and backslashes are refused before this runs, so each
 * script is a single command with at most an address in front of it, and
 * nothing in it is escaped.
 */
function sedReads(rest: string[]): boolean {
  const scripts: string[] = [];
  let firstOperand: string | undefined;
  let flagsEnded = false;

  for (let i = 0; i < rest.length; i += 1) {
    const word = rest[i]!;
    if (flagsEnded || word === "-" || !word.startsWith("-")) {
      firstOperand ??= word;
      continue;
    }
    if (word === "--") {
      flagsEnded = true;
      continue;
    }
    if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      const name = equals === -1 ? word : word.slice(0, equals);
      const glued = equals === -1 ? undefined : word.slice(equals + 1);
      // GNU sed takes any unambiguous prefix of a long option, so `--in` is
      // `--in-place` and `--exp` is `--expression`.
      const is = (flag: string) => name === flag || abbreviates(name, flag);
      if (is("--in-place") || is("--file")) return false;
      if (is("--expression")) {
        const script = glued ?? rest[(i += 1)];
        if (script === undefined) return false;
        scripts.push(script);
      } else if (is("--line-length") && glued === undefined) {
        i += 1;
      }
      continue;
    }
    // A short-flag cluster: letters until one that takes a value, whose
    // value is the rest of the cluster or, when that is empty, the next word.
    // `-l` takes a value on GNU sed and none on BSD sed, where the rest of
    // the cluster is more flags — `-li` is in-place there — so the letters
    // after `l` are still read as flags, and only an empty tail consumes
    // the next word.
    const cluster = word.slice(1);
    for (let j = 0; j < cluster.length; j += 1) {
      const letter = cluster[j]!;
      if (letter === "i" || letter === "f") return false;
      if (letter === "e") {
        const tail = cluster.slice(j + 1);
        const value = tail !== "" ? tail : rest[(i += 1)];
        if (value === undefined) return false;
        scripts.push(value);
        break;
      }
      if (letter === "l" && j === cluster.length - 1 && rest[(i += 1)] === undefined) return false;
    }
  }

  if (scripts.length === 0) {
    if (firstOperand === undefined) return false;
    scripts.push(firstOperand);
  }
  return scripts.every((script) => SED_READING_SCRIPT.test(script));
}

/** An address: a line, a step, or a regex — nothing escaped, so no `/` inside. */
const SED_ADDRESS = String.raw`(?:\d+(?:~\d+)?|/[^/]*/[IM]*)`;
const SED_ADDRESS2 = String.raw`(?:\d+|/[^/]*/[IM]*|[+~]\d+)`;
/**
 * The commands that only print, drop, substitute or transliterate. `s` and
 * `y` take a delimiter of their own choosing, matched by back-reference; the
 * flags `s` may carry exclude `w` and `e`. `a`, `i` and `c` only emit text.
 */
const SED_COMMAND = String.raw`(?:[pPdDnNgGhHxzF=]|[qQl]\s*\d*|[aic]\s+.*|s(.)(?:(?!\1).)*\1(?:(?!\1).)*\1[gpiImM0-9]*|y(.)(?:(?!\2).)*\2(?:(?!\2).)*\2)`;
const SED_READING_SCRIPT = new RegExp(
  String.raw`^\s*(?:${SED_ADDRESS}(?:\s*,\s*${SED_ADDRESS2})?\s*!?\s*)?${SED_COMMAND}\s*$`,
);

/**
 * Whether `word` is the given writing flag, in any of the spellings the
 * tool's parser accepts. A long option matches exactly, with a glued
 * `=value` (`--output=out.txt`), or as any proper prefix of its name — git's
 * parse-options and getopt_long both take an unambiguous abbreviation, so
 * `--open=rm` is `--open-files-in-pager=rm` and `--out=x` is `--output=x`.
 * Which abbreviations are unambiguous depends on the tool's full option
 * table, which is not known here, so every prefix of a banned option is
 * refused: a prefix that is also a prefix of a harmless option costs a
 * question, while the other way round costs a file.
 *
 * A short option matches exactly, with a glued value (`-oout.txt`), or as
 * one letter of a cluster (`-nOrm` carries `-O`, whose value is `rm`). A
 * letter of a glued value counts as well — `-Orm` and `-O'rm'` are the same
 * word — which is the side to err on.
 */
function matchesFlag(word: string, flag: string): boolean {
  if (word === flag) return true;
  if (flag.startsWith("--")) {
    const equals = word.indexOf("=");
    const name = equals === -1 ? word : word.slice(0, equals);
    return name === flag || abbreviates(name, flag);
  }
  if (word.startsWith("--")) return false;
  if (word.startsWith(flag)) return true;
  return flag.length === 2 && isCluster(word) && word.includes(flag[1]!, 1);
}

/**
 * Whether `name` is a proper prefix of the long option `flag`, with at least
 * one character after the dashes so that `--` on its own never matches.
 */
function abbreviates(name: string, flag: string): boolean {
  return name.length > 2 && name.length < flag.length && flag.startsWith(name);
}

/**
 * A word that a short-option parser reads letter by letter: `-`, optional
 * leading digits, a letter, and at least one more character. The digits are
 * allowed because git's parse-options eats the count in `-5Orm` and keeps
 * reading the rest of the word as options. A lone `-` is stdin and a word
 * that is only digits (`-5`) is a count, so neither is a cluster.
 */
function isCluster(word: string): boolean {
  return /^-\d*[A-Za-z]./.test(word);
}
