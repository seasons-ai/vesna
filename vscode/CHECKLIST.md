# Manual checklist

The extension host is not unit-tested (that would need
`@vscode/test-electron`) — this is the manual pass the spec's Testing
section asks for, run in a real VS Code before cutting a release. Every
line below is one bullet of the spec's "extension host" list.

## Verified in the reports

Seen and screenshotted in Task 6 and Task 7's manual checks (VS Code
1.134.0, driven over CDP against a real `vesna serve`); re-run these
quickly on the machine that is cutting the release, they should not have
regressed.

- [x] Activate with a folder open (a real repo, a real config: the activity
      bar mark, the Chat header, the status bar mode — task-6-report.md).
- [x] Mode from the status bar (clicking it cycled `auto → plan → auto`,
      the label and the transcript's mode notice both updated —
      task-6-report.md).
- [x] Restart after kill (`kill -9` of `vesna serve` showed the `Vesna
      exited.` banner with Restart; clicking it spawned a fresh server and
      cleared the banner, done twice — task-6-report.md).
- [x] The garden drawn from real server state (`/spec open demo` produced
      the full tree — stages, both tasks, worker/reviewer witnesses, the
      parked finding — matching the spec's events — task-7-report.md).
- [x] A finding as a diagnostic (squiggles at `a.ts:3` and `a.ts:5`,
      matching entries in the Problems panel, cleared and redrawn correctly
      after a file rename and Refresh — task-7-report.md).

## Not yet verified live

Not reached in either manual check — ollama was not running for Task 6/7's
session, and the demo `plan.md` named no tasks, so no real turn or build
ran. Run these before the first publish.

- [ ] `notFound` end to end (`vesna.command` pointing at a binary that does
      not exist) — unit-tested with a fake child only.
- [ ] `tooOld` end to end (a server whose `capabilities` are below
      `REQUIRED_CAPABILITIES`) — unit-tested only.
- [ ] `noFolder` (no workspace open) and a multi-root workspace (the `note`
      about the extra folders) in VS Code itself.
- [ ] The 12 s kill path in `stopServer` against a server that actually
      hangs on `shutdown` — unit-tested with a 30 ms ceiling.
- [ ] A real turn: a permission question, answering it with Always, the
      approve-the-plan question and its `y`/`n` buttons, and a `send`
      queued while the core is busy landing as `turnStarted` once the
      queued text's `user` echo arrives.
- [ ] Cancel replacing Build in the garden's title while a build is
      actually running (the `vesna.building` context key is wired and
      unit-tested; not seen live since no build ran).
- [ ] The running (`sync~spin`), failed and blocked task icons in the
      garden against a live build, not the pure mapping's unit tests.
