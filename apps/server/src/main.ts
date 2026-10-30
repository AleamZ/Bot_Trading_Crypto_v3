/**
 * Entry point. node:sqlite needs Node 22.13 or newer; check before anything imports it, so an old
 * Node prints what to do instead of a module error.
 *
 * No top-level await here: pm2 may load this file with require(), which cannot load an ES module
 * that awaits at the top level (ERR_REQUIRE_ASYNC_MODULE).
 */
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Bot v3 cần Node.js 22.13 trở lên (đang chạy ${process.versions.node}).`);
  process.exit(1);
}

import("./start.js")
  .then(({ run }) => run())
  .catch((error: unknown) => {
    // Bad .env, another bot on the same database, port in use: one readable line, then exit.
    console.error(`Bot v3 không khởi động được: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
