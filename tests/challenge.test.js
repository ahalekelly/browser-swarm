// The classifier against pages captured from live sites on 2026-10-31: quiet
// blocks that headless Chrome got with its HeadlessChrome user agent, and real
// pages as small as they are.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { challengeMarkers } from '../src/challenge.ts';

const pages = JSON.parse(fs.readFileSync(new URL('./fixtures/pages.json', import.meta.url), 'utf8'));

for (const [name, page] of Object.entries(pages.blocked)) {
  test(`${name} is a block`, () => {
    assert.notDeepEqual(challengeMarkers(page, page.url), []);
  });
}

for (const [name, page] of Object.entries(pages.real)) {
  test(`${name} is a real page`, () => {
    assert.deepEqual(challengeMarkers(page, page.url), []);
  });
}
