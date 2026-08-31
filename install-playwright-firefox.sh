#!/bin/bash
# Install the Firefox build named by the playwright-core registry pinned in
# package-lock.json. npm verifies the registry package checksum; Playwright uses
# that package's browser revision and verifies the installed executable.
set -euo pipefail

PLAYWRIGHT_VERSION=1.63.0-alpha-2026-08-05
FIREFOX_REVISION=1539
DIR="$(cd "$(dirname "$0")" && pwd)"

"$DIR/node_modules/.bin/playwright" --version | grep -qF "$PLAYWRIGHT_VERSION" || {
  echo "ERROR: installed Playwright version does not match $PLAYWRIGHT_VERSION (run npm ci)" >&2
  exit 1
}
node - "$DIR" "$FIREFOX_REVISION" <<'NODE'
const [dir, expectedRevision] = process.argv.slice(2);
const registry = require(`${dir}/node_modules/playwright-core/browsers.json`);
const firefox = registry.browsers.find((browser) => browser.name === 'firefox');
if (!firefox || firefox.revision !== expectedRevision) {
  console.error(`ERROR: playwright-core registry does not pin Firefox revision ${expectedRevision}`);
  process.exit(1);
}
NODE
"$DIR/node_modules/.bin/playwright" install firefox
node - "$DIR" <<'NODE'
const [dir] = process.argv.slice(2);
const { existsSync } = require('node:fs');
const { firefox } = require(`${dir}/node_modules/playwright-core`);
const executable = firefox.executablePath();
if (!existsSync(executable)) {
  console.error(`ERROR: Playwright Firefox executable is missing after install: ${executable}`);
  process.exit(1);
}
console.log(`Playwright Firefox installed at ${executable}`);
NODE
