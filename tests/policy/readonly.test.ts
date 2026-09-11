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
