# Contributing

Thanks for looking. This page is short on purpose: the rules that matter are
few, and each has a reason.

## An issue first, then a pull request

Open an issue before writing code. A pull request with no issue behind it is
closed with a request to open one — not as a formality, but because the
conversation about *whether* and *how* belongs before the diff, not in its
review. Three templates:

- **Bug report** — what you did, what happened, what you expected, and the
  exact output. A bug we can reproduce is a bug we can fix.
- **Feature request** — the problem first, the proposed shape second. Vesna
  refuses features that make a claim the code cannot back, so say what the
  evidence would be.
- **Partnership** — integrations, providers, or working together on the
  project. Say who you are and what you have in mind.

Once an issue is agreed, reference it from the pull request.

## Working on the code

```bash
bun install
bun test            # offline; anything reaching the network is a defect
bun run typecheck
```

Both must be green before you push, and the pull request template asks you
to paste the output. CI does not run on a pull request by itself — it costs
minutes, and a branch in progress is not yet worth them. The maintainer runs
it on the request when it is ready to merge, by adding the `ci` label.

For anything larger than a one-file fix, Vesna's own process applies: a spec,
an approved plan, and `/build`. Ask in the issue and we will point you at it.

## Commits

- English, in every artifact: code, comments, messages, docs.
- The message says what the diff does and why. It must not claim a property
  the code does not have — reviews check the body against the diff.
- No `Co-Authored-By` or other AI-attribution trailers. Tools are welcome;
  the commit is yours.

## Reviews

Every pull request is reviewed against two questions: does it do what the
issue asked, and nothing else; and would the tests fail against a broken
version. A test that passes against the bug it claims to guard is worth less
than no test. If you ran a check by hand, paste the output — a description of
output is not output.

## Contributors

Once a contribution of yours is merged, you may add yourself to the
[Contributors](README.md#contributors) list in the README: your GitHub avatar
linked to your profile, and, if you like, one sentence beside it.

The sentence is optional and is yours to write, with three limits: no
profanity, no aggression toward anyone, and no advertising. The maintainer may
shorten or decline a line; the avatar and link stay either way.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Releasing (maintainers)

A tag is a release. Nothing is published by hand.

```bash
npm version patch        # or minor, major — makes the commit and the tag
git push --follow-tags   # the tag starts .github/workflows/release.yml
```

The workflow runs the full CI, checks the tag against `package.json`, refuses
a version the registry already has, publishes with provenance, installs the
published package into an empty directory and runs it, and creates the GitHub
Release with generated notes. It needs one secret, `NPM_TOKEN`: a granular
access token for `@seasons-ai/vesna` with publish rights and *bypass 2FA*
enabled, set in the repository's Actions secrets.

The README's status line names the minor version; a minor or major bump
changes it, and a test fails until it does.
