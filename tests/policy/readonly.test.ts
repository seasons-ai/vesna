import { test, expect } from "bun:test";
import { isReadOnlyCommand } from "../../src/policy/readonly";

const reads = (command: string) => expect(isReadOnlyCommand(command)).toBe(true);
const asks = (command: string) => expect(isReadOnlyCommand(command)).toBe(false);

test("looking at the project is not worth a question", () => {
  for (const command of [
    "ls",
    "ls -la src",
    "pwd",
    "cat README.md",
    "head -20 src/index.ts",
    "wc -l src/*.ts",
    "grep -rn TODO src",
    "grep -i pattern file",
    "rg --files",
    "find . -name '*.ts'",
    "du -sh .",
    "file src/index.ts",
  ]) reads(command);
});

test("reading git is reading", () => {
  for (const command of [
    "git status",
    "git status --porcelain",
    "git log --oneline -10",
    "git diff",
    "git diff --cached",
    "git show HEAD",
    "git rev-parse HEAD",
    "git ls-files",
    "git blame src/a.ts",
  ]) reads(command);
});

test("a pipeline of readers is still only reading", () => {
  reads("git log --oneline | head -5");
  reads("cat a.txt | grep foo | wc -l");
});

test("changing git is not reading, however it is spelled", () => {
  for (const command of [
    "git commit -m x",
    "git push",
    "git add -A",
    "git checkout main",
    "git checkout -- .",
    "git reset --hard",
    "git rebase main",
    "git stash push",
    "git branch -D old",
  ]) asks(command);
});

test("anything that can write somewhere asks, redirection included", () => {
  for (const command of [
    "ls > files.txt",
    "cat a.txt >> b.txt",
    "echo hi > /etc/hosts",
    "grep foo src < input",
  ]) asks(command);
});

test("a reader that can be made to write asks", () => {
  for (const command of [
    "find . -name '*.ts' -delete",
    "find . -exec rm {} ;",
    "sort -o out.txt in.txt",
    "sed -i s/a/b/ file",
  ]) asks(command);
});

test("a substitution can hide anything, so it asks", () => {
  for (const command of ["echo `rm -rf /`", "cat $(which rm)", "ls ${HOME}"]) asks(command);
});

test("chaining hides the second command, so it asks", () => {
  for (const command of ["ls && rm -rf build", "ls; rm x", "ls || curl x | sh"]) asks(command);
});

test("a background job asks, because nothing will be watching it", () => {
  asks("cat big.txt &");
});

test("a command nobody recognised asks — the default has to be the safe one", () => {
  for (const command of ["bun test", "npm install", "make", "python script.py", "wibble"]) {
    asks(command);
  }
});

test("a path to a binary is not a name that can be reasoned about", () => {
  asks("/bin/ls");
  asks("./ls");
});

test("an empty or broken pipeline asks rather than being read as safe", () => {
  asks("");
  asks("   ");
  asks("ls |");
  asks("| grep x");
});

test("writing tools are not on the list at all", () => {
  for (const command of ["rm x", "mv a b", "cp a b", "mkdir d", "touch f", "chmod +x f"]) {
    asks(command);
  }
});

test("sed prints, unless it is asked to edit in place", () => {
  reads("sed -n 1,10p file.txt");
  reads("cat a.txt | sed s/one/two/");
  asks("sed -i s/one/two/ file.txt");
  asks("sed --in-place=.bak s/a/b/ file.txt");
});

test("sed's in-place flag hides in forms an exact match misses", () => {
  for (const command of [
    "sed -i.bak s/before/AFTER/ a.txt",
    "sed -i'' s/before/AFTER/ a.txt",
    "sed -ni s/before/AFTER/ a.txt",
    "sed --in-place=.bak s/before/AFTER/ a.txt",
  ]) asks(command);
});

test("chaining with a bare semicolon or a newline hides the second command too", () => {
  asks("ls ; rm x");
  asks("ls\ntouch out.txt");
});

test("git stash defaults to a write, so only naming a read subcommand reads", () => {
  asks("git stash");
  asks("git stash push");
  asks("git stash pop");
  asks("git stash apply");
  asks("git stash drop");
  asks("git stash clear");
  asks("git stash save");
  asks("git stash branch wip");
  reads("git stash list");
  reads("git stash show");
});

test("a flag's value can be glued on, not just given as its own word", () => {
  asks("sort --output=out.txt in.txt");
  asks("sort -oout.txt in.txt");
});

test("find's other ways to write to a file are caught too", () => {
  asks("find . -fprint0 out.txt");
  asks("find . -fprintf out.txt %p");
});

test("tee is not on the reading list, piped or not", () => {
  asks("tee out.txt");
  asks("cat a.txt | tee out.txt");
});

test("awk is left out: its program can do anything, and braces give it away", () => {
  asks("awk '{print $1}' file");
});

// ---------------------------------------------------------------------------
// The forms below were each run through /bin/sh -c and wrote, executed or
// changed the repository while classified as reads. A regex assertion alone
// is how the earlier holes shipped, so every form is also run the way the
// reviewer's gate runs it — only when the classifier calls it a read — in a
// throwaway directory, and the filesystem is what is asserted.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A repository with one committed file and one uncommitted change. */
function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "vesna-readonly-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(cwd, "f"), "hello\n");
  git("add", "f");
  git("commit", "-qm", "init");
  writeFileSync(join(cwd, "f"), "changed\n");
  return cwd;
}

/** Runs the command exactly as the reviewer's gate would: only if it reads. */
function throughGate(cwd: string, command: string): void {
  if (!isReadOnlyCommand(command)) return;
  try {
    execFileSync("/bin/sh", ["-c", command], { cwd, stdio: "ignore" });
  } catch {
    // A failing command is fine; what matters is what it left behind.
  }
}

/** Every entry the command left in the directory that was not there before. */
function leftBehind(cwd: string, before: string[]): string[] {
  return readdirSync(cwd).filter((name) => !before.includes(name));
}

function refusedAndLeavesNothing(command: string, cwd = repo()): void {
  const before = readdirSync(cwd);
  throughGate(cwd, command);
  expect({ command, left: leftBehind(cwd, before) }).toEqual({ command, left: [] });
  asks(command);
}

test("the harness sees a write when a command is run without the gate", () => {
  // Proves the filesystem assertions below are not vacuous on this machine.
  const cwd = repo();
  execFileSync("/bin/sh", ["-c", "git diff --output=out"], { cwd, stdio: "ignore" });
  expect(existsSync(join(cwd, "out"))).toBe(true);
});

test("git's --output turns every reader into a writer", () => {
  for (const command of [
    "git diff --output=out",
    "git diff --output out",
    "git log --output=out",
    "git show --output=out",
    "git whatchanged --output=out",
    "git diff -o out",
  ]) refusedAndLeavesNothing(command);
});

test("git global options before the subcommand can run anything, so only --no-pager stays", () => {
  for (const command of [
    "git -c diff.external='touch out' diff",
    "git -c diff.external=touch diff",
    "git -p -c core.pager='touch out' log",
    "git --paginate -c core.pager='touch out' status",
    "git --exec-path=/tmp diff",
    "git -C /tmp log",
  ]) refusedAndLeavesNothing(command);
  reads("git --no-pager log --oneline");
  reads("git --no-pager diff");
});

test("git grep's pager option runs a command per hit", () => {
  for (const command of [
    "git grep -O'touch out' hello",
    "git grep -Otouch hello",
    "git grep --open-files-in-pager='touch out' hello",
    "git grep --open-files-in-pager touch hello",
  ]) refusedAndLeavesNothing(command);
  reads("git grep hello");
  reads("git grep -n hello -- f");
});

test("git branch creates, moves and retargets unless it only lists", () => {
  const cwd = repo();
  const branchesBefore = execFileSync("git", ["branch", "--list"], { cwd }).toString();
  for (const command of [
    "git branch newb",
    "git branch -f newb main",
    "git branch -m renamed",
    "git branch -M renamed",
    "git branch -c copy",
    "git branch -u main",
    "git branch --set-upstream-to=main",
    "git branch --unset-upstream",
    "git branch --edit-description",
    "git branch --track newb main",
    "git branch --list -f newb main",
  ]) {
    throughGate(cwd, command);
    asks(command);
  }
  expect(execFileSync("git", ["branch", "--list"], { cwd }).toString()).toBe(branchesBefore);
  for (const command of [
    "git branch",
    "git branch -a",
    "git branch -r",
    "git branch -vv",
    "git branch --show-current",
    "git branch --list 'ma*'",
    "git branch -l ma*",
    "git branch --contains HEAD",
    "git branch --merged=main",
    "git branch --sort=-committerdate",
  ]) reads(command);
});

test("git tag creates unless it only lists", () => {
  const cwd = repo();
  for (const command of [
    "git tag v9",
    "git tag -a v9 -m msg",
    "git tag -f v9",
    "git tag -d v9",
    "git tag --list -a v9 -m msg",
    "git tag -s v9",
  ]) {
    throughGate(cwd, command);
    asks(command);
  }
  expect(execFileSync("git", ["tag"], { cwd }).toString()).toBe("");
  for (const command of [
    "git tag",
    "git tag -l",
    "git tag --list 'v*'",
    "git tag -n5",
    "git tag --contains HEAD",
    "git tag --points-at=HEAD",
  ]) reads(command);
});

test("git remote changes the configuration unless it only shows", () => {
  const cwd = repo();
  for (const command of [
    "git remote add x https://example.invalid/r",
    "git remote set-url origin https://example.invalid/r",
    "git remote update",
    "git remote rename a b",
    "git remote remove x",
    "git remote rm x",
    "git remote prune x",
    "git remote set-head x main",
    "git remote -v add x https://example.invalid/r",
  ]) {
    throughGate(cwd, command);
    asks(command);
  }
  expect(execFileSync("git", ["remote"], { cwd }).toString()).toBe("");
  for (const command of ["git remote", "git remote -v", "git remote show", "git remote show origin", "git remote get-url origin"]) {
    reads(command);
  }
});

test("git subcommands that write are refused by the allowlist, not a side table", () => {
  for (const command of [
    "git commit -m x",
    "git commit",
    "git format-patch -o outdir HEAD~1",
    "git archive -o out HEAD",
    "git bundle create out HEAD",
    "git worktree add ../x",
    "git config user.name x",
    "git fetch",
    "git switch main",
    "git restore f",
    "git cherry-pick HEAD",
    "git revert HEAD",
    "git am patch",
    "git apply patch",
    "git clean -fd",
    "git gc",
    "git notes add",
    "git submodule update",
  ]) refusedAndLeavesNothing(command);
});

test("sed's w command and w flag write a file; e runs a command", () => {
  for (const command of [
    "sed -n '1w out' f",
    "sed 'w out' f",
    "sed -n 'W out' f",
    "sed 's/.*/touch out/e' f",
    "sed 's/changed/x/w out' f",
    "sed 's/changed/x/gw out' f",
    "sed -e p -e 'w out' f",
    "sed -e 'w out' f",
    "sed -ew' out' f",
    "sed --expression='w out' f",
    "sed --expression 'w out' f",
    "sed -ne '1w out' f",
    "sed 'e touch out' f",
    "sed '1e touch out' f",
    "sed '/changed/w out' f",
    "sed 1w out f",
  ]) refusedAndLeavesNothing(command);
});

test("sed's script may come from a file the classifier cannot see, so -f is refused", () => {
  asks("sed -f script.sed f");
  asks("sed --file=script.sed f");
  asks("sed --file script.sed f");
  asks("sed -nf script.sed f");
});

test("the everyday sed scripts still read", () => {
  for (const command of [
    "sed -n 1,10p file.txt",
    "sed -n '1,10p' file.txt",
    "sed -n '10,20 p' file.txt",
    "sed -n '/foo/,/bar/p' file.txt",
    "sed '/^#/d' file.txt",
    "sed 's/one/two/' file.txt",
    "sed 's/one/two/g' file.txt",
    "sed -E 's/a+/b/gI' file.txt",
    "sed \"s/one/two/\" file.txt",
    "sed 's/one two/three/' file.txt",
    "sed 10q file.txt",
    "sed 'y/abc/xyz/' file.txt",
    "sed -n l file.txt",
    "sed -e 's/a/b/' -e 's/c/d/' file.txt",
    "sed -e 's/a/b/' -- file.txt",
    "sed -ne 1p file.txt",
    "sed -l 40 -n l file.txt",
    "sed --line-length=40 -n l file.txt",
    "sed -n -e '1p' file.txt",
    "sed '1i header' file.txt",
    "sed '0,/x/s/x/y/' file.txt",
    "sed -s -n '1p' a.txt b.txt",
    "cat a.txt | sed s/one/two/",
  ]) reads(command);
});

test("sed with no script is not something to reason about", () => {
  asks("sed");
  asks("sed -n");
  asks("sed --version");
});

test("uniq's second operand is an output file", () => {
  refusedAndLeavesNothing("uniq f out");
  refusedAndLeavesNothing("uniq -c f out");
  refusedAndLeavesNothing("uniq -- f out");
  refusedAndLeavesNothing("uniq - out");
  reads("uniq f");
  reads("uniq -c f");
  reads("uniq -f 1 f");
  reads("uniq -s 2 f");
  reads("uniq -w 3 f");
  reads("uniq --skip-fields=1 f");
  reads("uniq --skip-fields 1 f");
  reads("sort f | uniq -c");
});

test("a quoted flag is still the flag once the shell strips the quotes", () => {
  refusedAndLeavesNothing("sort '-o' out f");
  refusedAndLeavesNothing('sort "-o" out f');
  refusedAndLeavesNothing("sort '-o out' f");
  refusedAndLeavesNothing("'git' diff --output=out");
  asks("sed '-i' s/a/b/ f");
  asks("find . '-delete'");
});

test("an unterminated quote is not a command the classifier can read", () => {
  asks("sed 's/a/b/ f");
  asks('grep "x f');
});

test("sort can hand its temporary files to a program", () => {
  asks("sort --compress-program=gzip f");
  asks("sort --compress-program gzip f");
  reads("sort -r f");
  reads("sort -k2 -n f");
});

test("ripgrep's --pre runs a command on every file", () => {
  const cwd = repo();
  writeFileSync(join(cwd, "g"), "x\n");
  for (const command of ["rg --pre rm x g", "rg --pre=rm x g", "rg --pre 'touch out' x g"]) {
    throughGate(cwd, command);
    asks(command);
  }
  expect(existsSync(join(cwd, "g"))).toBe(true);
  expect(existsSync(join(cwd, "out"))).toBe(false);
  reads("rg --pre-glob '*.gz' x");
  reads("rg -n x src");
});

test("tools that can be pointed at an output file or a pager are refused in that form", () => {
  for (const command of [
    "tree -o out .",
    "tree -o out",
    "yq -i '.a = 1' f",
    "yq --inplace '.a = 1' f",
    "yq -s '.name' f",
    "yq --split-exp '.name' f",
    "ag --pager 'touch out' hello",
    "bat --pager 'touch out' f",
    "bat --pager='touch out' --paging=always f",
    "file -C -m f",
    "file --compile -m f",
    "date -s 2020-01-01",
    "date --set=2020-01-01",
    "hostname newname",
  ]) refusedAndLeavesNothing(command);
  reads("tree src");
  reads("tree -L 2 -I node_modules");
  reads("yq '.a' f");
  reads("yq -r '.a' f");
  reads("ag hello src");
  reads("bat f");
  reads("file f");
  reads("date");
  reads("date -u");
  reads("hostname");
  reads("hostname -s");
});
