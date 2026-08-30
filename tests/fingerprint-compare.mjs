#!/usr/bin/env node
// Run platform configs in ordered blocks. Targets are interleaved within each
// block, and every completed trial is appended before the next delay.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIGS = ['stock', 'linux', 'macos', 'windows'];
const TARGETS = {
  creepjs: 'https://abrahamjuliot.github.io/creepjs/',
  'browserleaks-webgl': 'https://browserleaks.com/webgl',
  'browserleaks-javascript': 'https://browserleaks.com/javascript',
  sannysoft: 'https://bot.sannysoft.com/',
  rebrowser: 'https://bot-detector.rebrowser.net/',
  amazon: 'https://www.amazon.com/dp/B0D1XD1ZV3',
  google: 'https://www.google.com/search?q=browser+automation',
};
const DETECTION_BODY_MARKERS = {
  akamai: /bazadebezolkohpepadr|\/akam\//i,
  datadome: /captcha-delivery|\bdd\s*=\s*\{/i,
  cloudflare: /challenges\.cloudflare\.com|just a moment|cf-chl-/i,
  perimeterx: /_pxhd|px-captcha/i,
  awsWaf: /window\.gokuProps|awsWafCookieDomainList|challenge-container/i,
  imperva: /Incapsula incident ID|_Incapsula_Resource/i,
  kasada: /x-kpsdk|KP_UIDz/i,
  f5: /the requested url was rejected/i,
  radware: /Radware Captcha Page|support@shieldsquare\.com/i,
  queueIt: /queueclient\.min\.js|botdetect\.min\.js/i,
  sucuri: /sucuri website firewall/i,
};
const CHALLENGE_BODY = /captcha-delivery|just a moment|cf-chl-|px-captcha|window\.gokuProps|challenge-container|Incapsula incident ID|the requested url was rejected|Radware Captcha Page|botdetect\.min\.js|sucuri website firewall/i;
const CHALLENGE_PATH_SEGMENT = /captcha|challenge|validate\.perfdrive\.com|queue-it\.net/i;
const CHALLENGE_TITLE = /^just a moment|access denied|error page|attention required|pardon our interruption|are you a human|verify you are human/i;
const DETECTION_COOKIE_MARKERS = {
  akamai: /^(?:_abck|bm_sz|ak_bmsc|bm_sv|bm_lso)$/,
  datadome: /^datadome$/,
  cloudflare: /^(?:__cf_bm|cf_clearance|__cfwaitingroom)$/,
  perimeterx: /^(?:_px|pxcts)/,
  awsWaf: /^aws-waf-token$/,
  imperva: /^(?:incap_ses|visid_incap|reese84|___utmvc)/,
  kasada: /^KP_UIDz(?:-ssn)?$/,
  f5: /^TS[a-fA-F0-9]{6,8}$/,
  queueIt: /^QueueITAccepted-SDFrts345E-V3_/,
};

const [command = 'help', ...args] = process.argv.slice(2);
if (command === 'run') await run(parseRunArgs(args));
else if (command === 'report') renderReport(parseReportArgs(args));
else usage();

async function run(options) {
  mkdirSync(dirname(options.jsonl), { recursive: true });
  const runId = `${new Date().toISOString()}-${process.pid}`;

  for (let configIndex = 0; configIndex < options.configs.length; configIndex += 1) {
    const config = options.configs[configIndex];
    const session = await launch(config, options.seed);
    try {
      const schedule = [];
      for (let trial = 1; trial <= options.trialsPerTarget; trial += 1) {
        for (const target of options.targets) schedule.push({ trial, target });
      }

      for (let scheduleIndex = 0; scheduleIndex < schedule.length; scheduleIndex += 1) {
        const { trial, target } = schedule[scheduleIndex];
        const record = await measure(session.browser, {
          runId,
          config,
          configIndex: configIndex + 1,
          trial,
          target,
          settleMs: options.settleMs,
          seed: options.seed,
        });
        appendFileSync(options.jsonl, `${JSON.stringify(record)}\n`);
        console.log(`${config} ${target.name} ${trial}/${options.trialsPerTarget}: ${record.rendered ? 'rendered' : record.challenge.join(', ')}`);
        if (scheduleIndex < schedule.length - 1) await delay(options.spacingMs);
      }
    } finally {
      await session.close();
    }

    if (configIndex < options.configs.length - 1 && options.cooldownMs > 0) {
      console.log(`cooldown: ${options.cooldownMs / 1000}s`);
      await delay(options.cooldownMs);
    }
  }

  renderReport({ jsonl: options.jsonl, report: options.report, runId });
}

async function launch(config, seed) {
  if (config === 'stock') {
    const binary = chromium.executablePath();
    if (!existsSync(binary)) fail(`stock Playwright Chromium is not installed (run ${join(ROOT, 'node_modules/.bin/playwright')} install chromium)`);
    const browser = await chromium.launch({ headless: true });
    return { browser, close: () => browser.close() };
  }

  const host = hostConfig();
  if (!existsSync(host.binary)) fail(`fingerprint-chromium is not installed at ${host.binary}`);
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'fingerprint-compare-'));
  const [program, ...prefix] = host.lowPriority;
  let browserLog = '';
  const child = spawn(program, [
    ...prefix,
    host.binary,
    '--headless',
    `--fingerprint=${seed}`,
    `--fingerprint-platform=${config}`,
    '--fingerprint-brand=Chrome',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (chunk) => {
    browserLog = `${browserLog}${chunk}`.slice(-20_000);
  });
  try {
    await waitForCdp(port, child, () => browserLog);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    return {
      browser,
      close: async () => {
        await browser.close().catch(() => {});
        if (child.exitCode === null) child.kill('SIGTERM');
        rmSync(profile, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM');
    rmSync(profile, { recursive: true, force: true });
    throw error;
  }
}

async function measure(browser, { runId, config, configIndex, trial, target, settleMs, seed }) {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    let response;
    page.on('response', (candidate) => {
      const request = candidate.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) response = candidate;
    });
    let navigationError;
    try {
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } catch (error) {
      navigationError = error.message;
    }
    await page.waitForTimeout(settleMs);
    const settledResponse = response;

    const body = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '');
    const bodySnippet = body.slice(0, 500);
    const title = await page.title().catch(() => '');
    const cookies = await context.cookies();
    const status = settledResponse?.status() ?? null;
    const requestHeaders = settledResponse ? await settledResponse.request().allHeaders() : {};
    const fingerprint = await readFingerprint(page).catch((error) => ({ error: error.message }));
    const challenge = classifyChallenge({
      status,
      targetUrl: target.url,
      finalUrl: page.url(),
      title,
      body: bodySnippet,
      navigationError,
    });
    return {
      type: 'trial',
      runId,
      measuredAt: new Date().toISOString(),
      host: `${process.platform} ${process.arch}`,
      config,
      configIndex,
      seed,
      target: target.name,
      targetUrl: target.url,
      trial,
      finalUrl: page.url(),
      status,
      rendered: challenge.length === 0,
      challenge,
      bodySnippet,
      detectors: detectSystems(body, cookies),
      navigationError: navigationError ?? null,
      requestHeaders: {
        'sec-ch-ua': requestHeaders['sec-ch-ua'] ?? null,
        'sec-ch-ua-platform': requestHeaders['sec-ch-ua-platform'] ?? null,
        'user-agent': requestHeaders['user-agent'] ?? null,
      },
      fingerprint,
      title,
    };
  } finally {
    await context.close();
  }
}

function parseRunArgs(args) {
  const values = parsePairs(args);
  for (const required of ['configs', 'targets', 'trials-per-target', 'spacing-seconds', 'cooldown-seconds', 'jsonl', 'report']) {
    if (values[required] === undefined) fail(`--${required} is required`);
  }
  const configs = csv(values.configs);
  for (const config of configs) {
    if (!CONFIGS.includes(config)) fail(`unknown config ${config}; use ${CONFIGS.join(', ')}`);
  }
  if (new Set(configs).size !== configs.length) fail('--configs must not contain duplicates');
  const targets = csv(values.targets).map(parseTarget);
  if (new Set(targets.map((target) => target.name)).size !== targets.length) fail('target labels must be unique');
  return {
    configs,
    targets,
    trialsPerTarget: positiveInteger(values['trials-per-target'], '--trials-per-target'),
    spacingMs: seconds(values['spacing-seconds'], '--spacing-seconds'),
    cooldownMs: seconds(values['cooldown-seconds'], '--cooldown-seconds'),
    settleMs: seconds(values['settle-seconds'] ?? '8', '--settle-seconds'),
    jsonl: resolve(values.jsonl),
    report: resolve(values.report),
    seed: values.seed ?? '42424242',
  };
}

function parseReportArgs(args) {
  const values = parsePairs(args);
  if (!values.jsonl || !values.report) fail('report requires --jsonl and --report');
  return { jsonl: resolve(values.jsonl), report: resolve(values.report), runId: values['run-id'] };
}

function parsePairs(args) {
  if (args.length % 2 !== 0) fail('arguments must be --name value pairs');
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith('--')) fail('arguments must be --name value pairs');
    values[args[index].slice(2)] = args[index + 1];
  }
  return values;
}

function parseTarget(value) {
  if (TARGETS[value]) return { name: value, url: TARGETS[value] };
  const separator = value.indexOf('=');
  if (separator < 1) fail(`unknown target ${value}; use a built-in name or label=https://url`);
  const name = value.slice(0, separator);
  const url = value.slice(separator + 1);
  if (!URL.canParse(url)) fail(`invalid target URL ${url}`);
  return { name, url };
}

function renderReport({ jsonl, report, runId }) {
  const records = readFileSync(jsonl, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        fail(`invalid JSON on ${jsonl} line ${index + 1}`);
      }
    })
    .filter((record) => record.type === 'trial' && (!runId || record.runId === runId))
    .map(scoreStoredRecord);
  if (records.length === 0) fail(`no trial records found in ${jsonl}${runId ? ` for run ${runId}` : ''}`);

  const lines = [
    `# Fingerprint platform comparison — ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    '',
    `Source: \`${basename(jsonl)}\` (${records.length} trials${runId ? `, run \`${runId}\`` : ''}).`,
    '',
  ];
  const targets = [...new Set(records.map((record) => record.target))];
  for (const target of targets) {
    lines.push(`## ${target}`, '', '| Config | Renders | First challenge | Sticky | Failure mode |', '|---|---:|---:|---|---|');
    const targetRecords = records.filter((record) => record.target === target);
    for (const group of groupBlocks(targetRecords)) {
      const ordered = group.records.toSorted((left, right) => left.trial - right.trial);
      const firstChallenge = ordered.find((record) => !record.rendered)?.trial ?? null;
      const sticky = firstChallenge === null ? '—' : ordered.filter((record) => record.trial >= firstChallenge).every((record) => !record.rendered) ? 'yes' : 'no';
      const failures = counts(ordered.flatMap((record) => record.challenge));
      lines.push(`| ${group.label} | ${ordered.filter((record) => record.rendered).length}/${ordered.length} | ${firstChallenge ?? '—'} | ${sticky} | ${failures || '—'} |`);
    }
    lines.push('');
  }

  lines.push('## Consistency leaks', '', '| Config | Leaks |', '|---|---|');
  for (const group of groupBlocks(records)) {
    const leaks = consistencyLeaks(group.config, group.records);
    lines.push(`| ${group.label} | ${leaks.join('<br>') || 'none'} |`);
  }
  lines.push('');
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, `${lines.join('\n')}\n`);
  console.log(`wrote ${report}`);
}

function groupBlocks(records) {
  const grouped = new Map();
  for (const record of records) {
    const key = `${record.runId}\0${record.config}`;
    if (!grouped.has(key)) grouped.set(key, { runId: record.runId, config: record.config, records: [] });
    grouped.get(key).records.push(record);
  }
  const configCounts = new Map();
  for (const group of grouped.values()) configCounts.set(group.config, (configCounts.get(group.config) ?? 0) + 1);
  return [...grouped.values()]
    .toSorted((left, right) => left.records[0].configIndex - right.records[0].configIndex || left.runId.localeCompare(right.runId))
    .map((group) => ({ ...group, label: configCounts.get(group.config) > 1 ? `${group.config} (${group.runId})` : group.config }));
}

function counts(values) {
  const result = new Map();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return [...result].map(([value, count]) => count === 1 ? value : `${value} ×${count}`).join(', ');
}

function hostConfig() {
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return {
      binary: join(ROOT, 'fingerprint-chromium/Chromium.app/Contents/MacOS/Chromium'),
      lowPriority: ['taskpolicy', '-c', 'utility'],
    };
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return {
      binary: join(ROOT, 'fingerprint-chromium/chrome'),
      lowPriority: ['nice', '-n', '10'],
    };
  }
  fail(`unsupported host ${process.platform} ${process.arch}`);
}

async function readFingerprint(page) {
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    const userAgentData = navigator.userAgentData;
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      languages: navigator.languages,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      clientHints: userAgentData ? {
        brands: userAgentData.brands,
        mobile: userAgentData.mobile,
        platform: userAgentData.platform,
        highEntropy: await userAgentData.getHighEntropyValues(['architecture', 'bitness', 'fullVersionList', 'model', 'platformVersion']),
      } : null,
      webgl: gl && debug ? {
        vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
        renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
      } : null,
    };
  });
}

function scoreStoredRecord(record) {
  const challenge = classifyChallenge({
    status: record.status,
    targetUrl: record.targetUrl,
    finalUrl: record.finalUrl,
    title: record.title,
    body: record.bodySnippet ?? '',
    navigationError: record.navigationError,
  });
  if (record.bodySnippet === undefined) {
    for (const marker of record.challenge) {
      if (marker === 'challenge-body' || marker === 'empty-page') challenge.push(marker);
    }
  }
  return { ...record, challenge: [...new Set(challenge)], rendered: challenge.length === 0 };
}

function classifyChallenge({ status, targetUrl, finalUrl, title, body, navigationError }) {
  const markers = [];
  if (navigationError) markers.push('navigation-error');
  if ([202, 403, 405, 406, 429].includes(status) || (status !== null && status >= 500)) markers.push(`status-${status}`);
  if (isChallengeUrl(targetUrl, finalUrl)) markers.push('challenge-url');
  if (CHALLENGE_TITLE.test(title)) markers.push('challenge-title');
  if (CHALLENGE_BODY.test(body)) markers.push('challenge-body');
  if (status !== null && status < 400 && title.trim() === '' && body.trim().length < 100) markers.push('empty-page');
  return [...new Set(markers)];
}

function isChallengeUrl(targetUrl, finalUrl) {
  const target = new URL(targetUrl);
  const final = new URL(finalUrl);
  if (final.host !== target.host) return true;
  const targetSegments = new Set(target.pathname.split('/').filter(Boolean).map((segment) => segment.toLowerCase()));
  return final.pathname.split('/').filter(Boolean).some((segment) => CHALLENGE_PATH_SEGMENT.test(segment) && !targetSegments.has(segment.toLowerCase()));
}

function detectSystems(body, cookies) {
  const systems = new Set();
  for (const [name, pattern] of Object.entries(DETECTION_BODY_MARKERS)) {
    if (pattern.test(body)) systems.add(name);
  }
  for (const [name, pattern] of Object.entries(DETECTION_COOKIE_MARKERS)) {
    if (cookies.some((cookie) => pattern.test(cookie.name))) systems.add(name);
  }
  return [...systems];
}

function consistencyLeaks(config, trials) {
  const platform = config === 'stock' ? trials[0].host.startsWith('darwin ') ? 'macos' : 'linux' : config;
  const expected = {
    linux: { navigator: 'Linux x86_64', ua: /Linux/, hints: 'Linux' },
    macos: { navigator: 'MacIntel', ua: /Mac OS X/, hints: 'macOS' },
    windows: { navigator: 'Win32', ua: /Windows NT/, hints: 'Windows' },
  }[platform];
  const leaks = new Set();
  for (const trial of trials) {
    const fingerprint = trial.fingerprint;
    if (fingerprint.error) {
      leaks.add(`trial ${trial.trial}: fingerprint unreadable`);
      continue;
    }
    if (fingerprint.platform !== expected.navigator) leaks.add(`navigator.platform=${fingerprint.platform}`);
    if (!expected.ua.test(fingerprint.userAgent)) leaks.add(`UA=${fingerprint.userAgent}`);
    if (fingerprint.clientHints?.platform !== expected.hints) leaks.add(`client hints platform=${fingerprint.clientHints?.platform}`);
    const headerPlatform = trial.requestHeaders['sec-ch-ua-platform'];
    if (headerPlatform && headerPlatform.replaceAll('"', '') !== expected.hints) leaks.add(`sec-ch-ua-platform=${headerPlatform}`);
    const renderer = `${fingerprint.webgl?.vendor ?? ''} ${fingerprint.webgl?.renderer ?? ''}`;
    if (/SwiftShader|llvmpipe|Mesa/i.test(renderer) || (platform !== 'linux' && /Linux/i.test(renderer))) {
      leaks.add(`WebGL=${renderer.trim()}`);
    }
  }
  return [...leaks];
}

async function waitForCdp(port, process, log) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (process.exitCode !== null) fail(`Chromium exited ${process.exitCode} while starting:\n${log()}`);
    if (await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.ok).catch(() => false)) return;
    await delay(200);
  }
  fail(`Chromium did not open CDP port ${port}:\n${log()}`);
}

function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

function csv(value) {
  const values = value.split(',').map((item) => item.trim()).filter(Boolean);
  if (values.length === 0) fail('comma-separated lists cannot be empty');
  return values;
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) fail(`${name} must be a positive integer`);
  return number;
}

function seconds(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) fail(`${name} must be a nonnegative number`);
  return number * 1000;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function usage() {
  console.log(`Usage:
  node tests/fingerprint-compare.mjs run --configs stock,macos,linux,windows --targets creepjs,browserleaks-javascript --trials-per-target 1 --spacing-seconds 0 --cooldown-seconds 0 [--settle-seconds 8] --jsonl results.jsonl --report report.md
  node tests/fingerprint-compare.mjs report --jsonl results.jsonl --report report.md [--run-id ID]

Targets may be built-in names or label=https://url.`);
  process.exit(command === 'help' ? 0 : 2);
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(2);
}
