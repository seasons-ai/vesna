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

test("awk is left out: its program can do anything, and braces give it away", () => {
  asks("awk '{print $1}' file");
});
