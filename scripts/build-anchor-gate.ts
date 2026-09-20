import { copyFile, cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export async function buildAnchorGateBrowser(directory?: string) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const destination = directory ?? resolve(root, "public");
  await mkdir(destination, { recursive: true });
  await build({
    absWorkingDir: root,
    entryPoints: ["web/anchor-gate.ts"],
    outfile: resolve(destination, "anchor-gate.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
    logLevel: "silent",
  });
  await copyFile(
    resolve(root, "web/anchor-gate.html"),
    resolve(destination, "anchor-gate.html")
  );
  await copyFile(
    resolve(root, "web/anchor-gate.css"),
    resolve(destination, "anchor-gate.css")
  );
  await cp(
    resolve(root, "web/fonts"),
    resolve(destination, "anchor-gate-fonts"),
    {
      recursive: true,
    }
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void buildAnchorGateBrowser().catch(() => {
    console.error("Unable to build the anchor gate browser assets.");
    process.exitCode = 1;
  });
}
