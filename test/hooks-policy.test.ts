import { describe, expect, it } from "vitest";

const policy = await import(
  new URL("../scripts/hooks-policy.mjs", import.meta.url).href
);

describe("commit message policy", () => {
  it.each([
    "feat",
    "fix",
    "refactor",
    "perf",
    "ci",
    "build",
    "docs",
    "test",
    "chore",
    "merge",
    "revert",
  ])("accepts the allowed %s type", (type) =>
    expect(
      policy.validateCommitMessage(`${type}(verifier): check proof\n`)
    ).toEqual([])
  );
  it.each([
    "Update verifier\n",
    "style: change layout\n",
    "feat: \n",
    "feat: change\n\nbody\n",
    "feat: change\nCo-authored-by: someone\n",
    "feat: Co-authored-by: someone\n",
    "feat: change\u2014layout\n",
    "feat: T\u00fcrk\u00e7e\n",
    "feat: " + "a".repeat(64) + "\n",
  ])("rejects an invalid title or body", (message) => {
    expect(policy.validateCommitMessage(message).length).toBeGreaterThan(0);
  });
  it("accepts 69 characters and a standard CRLF terminator", () => {
    expect(
      policy.validateCommitMessage("feat: " + "a".repeat(63) + "\r\n")
    ).toEqual([]);
  });
});

describe("staged path and text policy", () => {
  it.each([
    "CLAUDE.md",
    "docs/CLAUDE.md",
    ".claude/settings.json",
    "src/.CLAUDE/notes.md",
  ])("blocks forbidden path %s", (path) =>
    expect(policy.validateStagedPath(path).length).toBeGreaterThan(0)
  );
  it("does not block an unrelated name", () => {
    expect(policy.validateStagedPath("src/claude-client.ts")).toEqual([]);
  });
  it.each([
    "src/turkey.ts",
    "test/turkey.test.ts",
    "server/questionnaire/items.json",
    "web/messages/tr.json",
    "server/src/language/normalize.ts",
  ])("allows only Turkish letters in approved path %s", (path) => {
    expect(
      policy.validateAddedText(path, [
        "\u00c7\u011e\u0130\u00d6\u015e\u00dc\u00e7\u011f\u0131\u00f6\u015f\u00fc",
      ])
    ).toEqual([]);
    expect(policy.validateAddedText(path, ["\u2014"])).not.toEqual([]);
    expect(policy.validateAddedText(path, ["\ud83d\ude00"])).not.toEqual([]);
  });
  it.each([
    "docs/plan.md",
    "server/questionnaire/README.md",
    "test/fixtures/arbitrary.txt",
    "locales/tr/messages.json",
    "src/other.ts",
  ])("does not invent a Unicode exception for %s", (path) => {
    expect(policy.validateAddedText(path, ["T\u00fcrk\u00e7e"])).not.toEqual(
      []
    );
  });
  it("allows the specific bank display fields but not unrelated config strings", () => {
    expect(
      policy.validateAddedText("src/config.ts", [
        "bankName: str(env.BANK_NAME, 'Banka A.\u015e.'),",
      ])
    ).toEqual([]);
    expect(
      policy.validateAddedText("src/config.ts", [
        "  'TR Mock Anchor Teknoloji A.\u015e.',",
      ])
    ).toEqual([]);
    expect(
      policy.validateAddedText("src/config.ts", ["other: 'T\u00fcrk\u00e7e',"])
    ).not.toEqual([]);
  });
  it("keeps CLI double-hyphen options valid and rejects prose Unicode dashes", () => {
    expect(
      policy.validateAddedText("docs/run.md", ["Run tool --flag value."])
    ).toEqual([]);
    expect(
      policy.validateAddedText("docs/run.md", ["words\u2014\u2014words"])
    ).not.toEqual([]);
  });
  it("rejects unsupported control characters", () => {
    expect(
      policy.validateAddedText("src/new.ts", ["bad\u0000text"])
    ).not.toEqual([]);
  });
  it("ignores removed legacy Unicode while checking added lines", () => {
    const diff =
      "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\u2014text\n+ASCII replacement\n";
    const lines = policy.addedLinesFromDiff(diff);
    expect(lines).toEqual(["ASCII replacement"]);
    expect(policy.validateAddedText("src/a.ts", lines)).toEqual([]);
  });
  it("does not confuse an added plus-prefixed line with the file header", () => {
    expect(
      policy.addedLinesFromDiff("+++ b/a.ts\n@@ -1 +1 @@\n+++added\n")
    ).toEqual(["++added"]);
  });
  it("parses renames, spaces and newlines without treating old names as staged destinations", () => {
    expect(
      policy.parseNameStatus(
        "R100\0old name\0new name\0M\0line\nname\0A\0new.ts\0"
      )
    ).toEqual([
      { status: "R100", path: "new name" },
      { status: "M", path: "line\nname" },
      { status: "A", path: "new.ts" },
    ]);
  });
});
