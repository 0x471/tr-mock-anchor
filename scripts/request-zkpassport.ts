console.error(
  "Direct Node-origin requests are disabled: the mobile app rejects Origin: nodejs.\n" +
    "Run npm run zkpassport:browser -- --dev-mode, then open the printed localhost URL.\n" +
    "For options: npm run zkpassport:browser -- --help"
);
process.exitCode = process.argv.slice(2).join(" ") === "--help" ? 0 : 1;
