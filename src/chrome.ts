// How BrowserSwarm runs Google Chrome, shared by the controller and
// tests/fingerprint-compare.mjs so measurements match production.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CHROME_BINARY = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : '/usr/bin/google-chrome-stable';
export const HEADED_SCREEN = { width: 1920, height: 1080 };
export const VIEWPORT = '1280x720';

// Google services an agent's browser has no use for. The component updater
// and background networking stay on, so CRLSet revocation updates still
// arrive; field trials stay on, because disabling them changes the fingerprint.
const DISABLED_FEATURES = [
  'OptimizationGuideModelDownloading',
  'OptimizationHintsFetching',
  'OptimizationTargetPrediction',
  'OptimizationHints',
  'OptimizationGuideOnDeviceModel',
  'OnDeviceModelPerformanceParams',
  'Translate',
  'MediaRouter',
  'DialMediaRouteProvider',
  'AutofillServerCommunication',
];

export function chromeArgs(headed: boolean, port: number, profile: string): string[] {
  const linux = process.platform === 'linux';
  return [
    // Headed Chrome draws on Xvfb, never on a Wayland desktop it might find.
    ...(headed ? [`--window-size=${HEADED_SCREEN.width},${HEADED_SCREEN.height}`, '--ozone-platform=x11'] : ['--headless']),
    // Headless Chrome still plays page audio through the speakers.
    '--mute-audio',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-search-engine-choice-screen',
    '--disable-sync',
    `--disable-features=${DISABLED_FEATURES.join(',')}`,
    // Xvfb has no GPU, so WebGL reaches the host GPU through Vulkan instead.
    ...(linux ? ['--use-angle=vulkan', '--enable-features=Vulkan', '--password-store=basic'] : ['--use-mock-keychain']),
  ];
}

// Safe Browsing has no command-line switch; Chrome keeps a pref seeded here.
export function disableSafeBrowsing(profile: string): void {
  const file = join(profile, 'Default', 'Preferences');
  mkdirSync(join(profile, 'Default'), { recursive: true });
  const prefs = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  prefs.safebrowsing = { ...prefs.safebrowsing, enabled: false };
  writeFileSync(file, JSON.stringify(prefs));
}

// Headless Chrome names itself HeadlessChrome only in the UA string; its client
// hints already report Google Chrome. Playwright's context UA override covers
// frames, workers and popups and keeps the client hints Chrome fills in.
export function headlessUserAgent(browserUserAgent: string): string {
  return browserUserAgent.replace('HeadlessChrome/', 'Chrome/');
}
