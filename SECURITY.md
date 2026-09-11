# Security

Vesna runs model-written commands on your machine. The permission layer decides
what may run, and the read-only classifier decides what a reviewer may run —
and that classifier has needed a fix in every review it has had. Holes in it
are the most likely class of report.

**Do not open a public issue.** Email `lookoffdev@gmail.com` with:

- the command or input that gets past a guard it should not;
- what it does when it runs;
- the version (`vesna --version`) and platform.

You will get an answer within a few days. Fixes are released as a patch and
the report credited unless you ask otherwise.

What is *not* a vulnerability: `script` and `shell` running with your own
privileges under `permissions.mode: auto`. That is documented behaviour — the
README says plainly that this is policy, not a sandbox — and containment is on
the roadmap rather than claimed.
