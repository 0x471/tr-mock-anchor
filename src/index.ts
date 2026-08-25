// Load .env (if present) before any module reads process.env.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env: rely on the environment */
}
const { main } = await import('./server.js');
await main();
