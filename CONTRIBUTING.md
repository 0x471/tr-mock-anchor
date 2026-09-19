# Contributing

Use Node.js 22.13 or newer and the existing npm lockfile. Install dependencies
with `npm ci`. Do not introduce another dependency lockfile.

Install the repository-local hooks with:

```sh
pnpm hooks:install
```

The command uses the locally installed Husky dependency. It does not install
packages with pnpm. `npm ci` also installs the hooks through `prepare`.

## Commit checks

The pre-commit hook checks staged additions, runs Prettier through lint-staged,
checks the resulting staged additions again, then runs `npm run typecheck` and
`npm test`. Prettier changes staged files only. Type checking and tests cover
the project. Rust checks remain part of the contract workflow.

Never commit `CLAUDE.md` or files under `.claude`. New paths must be printable
ASCII. New text and added lines must be ASCII, except Turkish letters in these
explicit product paths:

- `server/questionnaire/`
- `web/messages/`
- `server/src/agent/`
- `server/src/interview/`
- `server/src/language/`
- `server/src/questionnaire/`
- `src/turkey.ts` and `test/turkey.test.ts`
- The bank-name and account-holder display strings in `src/config.ts`.

Documentation remains ASCII, including documentation inside those paths.
Binary proof fixtures are not treated as UTF-8 text. Existing unchanged text is
not revalidated. Unicode punctuation and emoji are not allowed. Use single
ASCII hyphens in prose; preserve required syntax such as CLI `--options`.
Human review must still confirm that Turkish text is a product requirement,
not commentary, and that any new fixture exception is narrowly justified.
Do not add generated attribution or comments that merely restate the code.

Commit messages must contain one printable ASCII title shorter than 70
characters, with no body, co-author trailer, or attribution. Use:

```text
type(optional-scope): concise description
```

Allowed types: `feat`, `fix`, `refactor`, `perf`, `ci`, `build`, `docs`, `test`,
`chore`, `merge`, and `revert`.

Run `npm run hooks:check` to inspect staged additions without formatting them.
The hooks never stage the initial files or create a commit. lint-staged may
update the index for formatting changes within the files already staged.
