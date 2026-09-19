import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("browser diagnostic entry points", () => {
  it("refuses the old Node-origin flow without starting a phone session", () => {
    const result = run("scripts/request-zkpassport.ts", [
      "--domain",
      "localhost",
      "--dev-mode",
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Origin: nodejs");
    expect(result.stderr).toContain("npm run zkpassport:browser");
    expect(result.stdout).toBe("");
  });

  it("provides browser CLI help without starting a server", () => {
    const result = run("scripts/serve-zkpassport.ts", ["--help"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("http://localhost:8792");
    expect(result.stdout).toContain("--dev-mode");
    expect(result.stderr).toBe("");
  });

  it("bundles the real pinned SDK for a browser without Node shims", async () => {
    const result = await build({
      absWorkingDir: root,
      entryPoints: ["web/zkpassport-diagnostic.ts"],
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "es2022",
      write: false,
      logLevel: "silent",
    });
    expect(result.outputFiles).toHaveLength(1);
    expect(result.outputFiles[0]?.text.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });
});
