import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const commitPattern =
  /^(feat|fix|refactor|perf|ci|build|docs|test|chore|merge|revert)(\([a-zA-Z0-9][a-zA-Z0-9._/-]*\))?: \S(?:.*\S)?$/;
const turkishPrefixes = [
  "server/questionnaire/",
  "web/messages/",
  "server/src/agent/",
  "server/src/interview/",
  "server/src/language/",
  "server/src/questionnaire/",
];
const turkishFiles = new Set(["src/turkey.ts", "test/turkey.test.ts"]);
const allowedTurkish =
  /^[\x00-\x7f\u00c7\u011e\u0130\u00d6\u015e\u00dc\u00e7\u011f\u0131\u00f6\u015f\u00fc]*$/u;

export function validateCommitMessage(message) {
  const errors = [];
  const title = message.replace(/\r?\n$/, "");
  if (!/^[\x20-\x7e]+$/.test(title)) {
    errors.push(
      "Commit message must be one printable ASCII title, with no body or trailers."
    );
  }
  if (title.length >= 70)
    errors.push("Commit title must be shorter than 70 characters.");
  if (!commitPattern.test(title)) {
    errors.push(
      "Use type(optional-scope): description with an allowed conventional type."
    );
  }
  if (/co-authored-by\s*:/i.test(title))
    errors.push("Co-author trailers are not allowed.");
  return errors;
}

export function validateStagedPath(path) {
  const parts = path.replaceAll("\\", "/").split("/");
  if (
    parts.some((part) => ["claude.md", ".claude"].includes(part.toLowerCase()))
  ) {
    return ["CLAUDE.md and .claude paths must not be committed."];
  }
  return [];
}

function allowsTurkish(path, line) {
  if (/\.(md|mdx|rst)$/i.test(path) || path.startsWith("docs/")) return false;
  if (
    turkishFiles.has(path) ||
    turkishPrefixes.some((prefix) => path.startsWith(prefix))
  ) {
    return true;
  }
  if (path !== "src/config.ts") return false;
  return (
    /^\s*(bankName|accountHolder)\s*:\s*str\(\s*env\.(BANK_NAME|ACCOUNT_HOLDER)\s*,/.test(
      line
    ) ||
    /^\s*["']TR Mock (Bank|Anchor Teknoloji) A\.\u015e\.["'],?\s*$/.test(line)
  );
}

export function validateAddedText(path, lines) {
  const errors = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (
      /[^\x00-\x7f]/.test(line) &&
      !(allowsTurkish(path, line) && allowedTurkish.test(line))
    ) {
      errors.push(
        `Added line ${index + 1} contains text outside the ASCII/Turkish allowlist.`
      );
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line)) {
      errors.push(
        `Added line ${index + 1} contains an unsupported control character.`
      );
    }
  }
  return errors;
}

export function addedLinesFromDiff(diff) {
  let inHunk = false;
  const added = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    if (line.startsWith("@@ ")) inHunk = true;
    else if (inHunk && line.startsWith("+")) added.push(line.slice(1));
  }
  return added;
}

export function parseNameStatus(output) {
  const fields = output.split("\0");
  const entries = [];
  for (let i = 0; i < fields.length && fields[i];) {
    const status = fields[i++];
    let path = fields[i++];
    if (status.startsWith("R") || status.startsWith("C")) path = fields[i++];
    if (!path) throw new Error("Malformed staged path listing.");
    entries.push({ status, path });
  }
  return entries;
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

export function inspectStagedChanges(cwd = process.cwd()) {
  const entries = parseNameStatus(
    git(["diff", "--cached", "--name-status", "-z", "--diff-filter=ACMR"], cwd)
  );
  const binaryPaths = new Set(
    git(["diff", "--cached", "--numstat", "--no-renames", "-z"], cwd)
      .split("\0")
      .filter((entry) => entry.startsWith("-\t-\t"))
      .map((entry) => entry.slice(4))
  );
  const errors = [];
  for (const { status, path } of entries) {
    const pathErrors = validateStagedPath(path);
    if (status.startsWith("A") && !/^[\x20-\x7e]+$/.test(path)) {
      pathErrors.push("New file paths must be printable ASCII.");
    }
    if (pathErrors.length) {
      errors.push(
        ...pathErrors.map((error) => `${JSON.stringify(path)}: ${error}`)
      );
      continue;
    }
    if (binaryPaths.has(path)) continue;
    // Read the index, not the working tree: unstaged edits must not affect a commit.
    const lines = status.startsWith("A")
      ? git(["show", `:${path}`], cwd).split("\n")
      : addedLinesFromDiff(
          git(
            [
              "diff",
              "--cached",
              "--no-ext-diff",
              "--no-color",
              "--unified=0",
              "--",
              path,
            ],
            cwd
          )
        );
    errors.push(
      ...validateAddedText(path, lines).map(
        (error) => `${JSON.stringify(path)}: ${error}`
      )
    );
  }
  return errors;
}

export function runCli(args = process.argv.slice(2)) {
  let errors;
  if (args[0] === "staged" && args.length === 1) {
    errors = inspectStagedChanges();
  } else if (args[0] === "commit-msg" && args.length === 2) {
    errors = validateCommitMessage(readFileSync(args[1], "utf8"));
  } else {
    throw new Error(
      "Usage: hooks-policy.mjs staged | commit-msg <message-file>"
    );
  }
  for (const error of errors) console.error(error);
  return errors.length ? 1 : 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Hook check failed."
    );
    process.exitCode = 1;
  }
}
