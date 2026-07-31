#!/usr/bin/env node
const { spawn } = require("node:child_process");

const script = process.argv[2];
if (!script) throw new Error("usage: kill-launcher-descendants.js <shared-browser.sh>");

const launcher = spawn(script, ["ensure"], {
  detached: true,
  stdio: "inherit",
});

launcher.on("error", (error) => {
  throw error;
});

launcher.on("exit", (code) => {
  try {
    process.kill(-launcher.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }

  setTimeout(() => {
    if (code !== 1) {
      console.error(`expected the crash-reporting launcher to exit 1, got ${code}`);
      process.exit(1);
    }
    process.exit(0);
  }, 250);
});
