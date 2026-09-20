// The real gate for one backend: real browser, real Playwright MCP, private
// profile, private output root, allocated ports. Fakes can prove the
// controller's bookkeeping; only this proves that two agents on one browser
// actually see different tabs, cookies and files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { createFixture, eventually, startController } from './helpers.js';

export function realBrowserTests(backend) {
  test(`two ${backend} contexts share a browser and nothing else`, async (t) => {
    const fixture = await createFixture(t, { realBrowser: true, IDLE_MS: 600_000 });
    const controller = await startController(t, fixture);
    const site = await testSite(t);

    const first = await context(controller, backend);
    const second = await context(controller, backend);
    assert.equal((await controller.call('GET', '/status')).body.browsers.length, 1);

    await Promise.all([
      first.call('browser_navigate', { url: `${site}/first` }),
      second.call('browser_navigate', { url: `${site}/second` }),
    ]);

    const [firstTabs, secondTabs] = await Promise.all([
      first.call('browser_tabs', { action: 'list' }),
      second.call('browser_tabs', { action: 'list' }),
    ]);
    assert.match(firstTabs, /\/first/);
    assert.doesNotMatch(firstTabs, /\/second/);
    assert.match(secondTabs, /\/second/);
    assert.doesNotMatch(secondTabs, /\/first/);

    // /first and /second each set their own cookie on the same origin.
    const cookies = await Promise.all([
      first.call('browser_evaluate', { function: '() => document.cookie' }),
      second.call('browser_evaluate', { function: '() => document.cookie' }),
    ]);
    assert.match(cookies[0], /visited=first/);
    assert.doesNotMatch(cookies[0], /visited=second/);
    assert.match(cookies[1], /visited=second/);
    assert.doesNotMatch(cookies[1], /visited=first/);

    // Playwright MCP links artifacts relative to the workspace root, which the
    // controller sets to the context's output dir, so a link resolves there
    // and nowhere near the calling agent's project.
    const shots = await Promise.all([
      first.call('browser_take_screenshot', {}),
      second.call('browser_take_screenshot', {}),
    ]);
    const files = [first, second].map((entry, index) => {
      const link = shots[index].match(/]\((\.\/[^)]+\.(?:png|jpeg|jpg))\)/)[1];
      const file = path.resolve(entry.outputDir, link);
      assert.equal(path.dirname(file), entry.outputDir, `screenshot ${link} escaped its context's output dir`);
      assert.ok(fs.statSync(file).size > 0);
      return file;
    });

    // `swarm ls` reads page URLs out of the real browser_tabs response.
    const listed = (await controller.call('GET', '/contexts')).body.contexts;
    assert.deepEqual(listed.map((entry) => entry.pages).flat().sort(), [`${site}/first`, `${site}/second`]);

    await first.close();
    const survivor = await second.call('browser_tabs', { action: 'list' });
    assert.match(survivor, /\/second/);
    assert.ok(fs.statSync(files[0]).size > 0, 'artifacts did not survive their context');
  });

  test(`an idle ${backend} context is released and its browser stops`, async (t) => {
    const fixture = await createFixture(t, { realBrowser: true, IDLE_MS: 5_000 });
    const controller = await startController(t, fixture);
    const entry = await context(controller, backend);
    await entry.call('browser_navigate', { url: 'about:blank' });

    await eventually(async () => (await controller.call('GET', '/contexts')).body.contexts.length === 0, 30_000, 'context expiry');
    await eventually(async () => !(await controller.call('GET', '/status')).body.browsers[0].running, 30_000, 'browser stop');
  });
}

async function context(controller, backend) {
  const opened = await controller.call('POST', '/contexts', { backend });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  return {
    id: opened.body.id,
    outputDir: opened.body.outputDir,
    call: async (name, args) => {
      const result = await controller.call('POST', `/contexts/${opened.body.id}/call`, { name, arguments: args });
      assert.equal(result.status, 200, `${name}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.isError, false, `${name}: ${result.body.text}`);
      return result.body.text;
    },
    close: () => controller.call('DELETE', `/contexts/${opened.body.id}`),
  };
}

async function testSite(t) {
  const server = http.createServer((request, response) => {
    const name = request.url.slice(1);
    if (name === 'favicon.ico') {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.setHeader('set-cookie', `visited=${name}; Path=/`);
    response.setHeader('content-type', 'text/html');
    response.end(`<title>${name}</title><h1>${name}</h1>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}
