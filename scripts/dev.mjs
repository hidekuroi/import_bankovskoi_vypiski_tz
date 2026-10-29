// One command for the whole stack: the unchanged kit mock plus Expo.
//   node scripts/dev.mjs start         → mock + Metro for the development build
//   node scripts/dev.mjs run:ios       → mock + native build, install, Metro
//   node scripts/dev.mjs run:android   → same for Android
// `--device` (Expo's own flag: a real phone) or `--lan` (an app already on a
// phone) opens the mock to the local network and points the app at the Mac's
// address, since 127.0.0.1 on a phone is the phone itself.
// While it runs, every booted simulator / connected Android device gets the
// kit's fixtures in its file picker, and Android devices get `adb reverse`.
import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  androidDevices,
  bootedSimulators,
  ensureOversizeFixture,
  ensureReverse,
  findAdb,
  KIT,
  MOCK_PORT,
  pushAndroidFixtures,
  seedSimulator,
} from "./devices.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mockUrl = `http://127.0.0.1:${MOCK_PORT}`;
const say = (message) => console.log(`\x1b[36m[dev]\x1b[0m ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mockIsUp() {
  try {
    return (await fetch(`${mockUrl}/health`, { signal: AbortSignal.timeout(800) })).ok;
  } catch {
    return false;
  }
}

function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal) return entry.address;
  }
  return null;
}

async function reachable(url) {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) })).ok;
  } catch {
    return false;
  }
}

async function startMock(lanUrl) {
  if (await mockIsUp()) {
    if (lanUrl && !(await reachable(lanUrl))) {
      console.error(`[dev] a mock is already running on ${mockUrl} only; stop it so it can start on the local network`);
      process.exit(1);
    }
    say(`mock already running at ${lanUrl ?? mockUrl}, using it`);
    return null;
  }
  // Exactly the kit's `npm start`, so its state file stays kit/.mock-state.json;
  // HOST is the kit's own setting.
  const env = lanUrl ? { ...process.env, HOST: "0.0.0.0" } : process.env;
  const child = spawn(process.execPath, ["mock-server.mjs"], { cwd: KIT, env, stdio: ["ignore", "inherit", "inherit"] });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await mockIsUp()) return child;
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  child.kill();
  console.error(`[dev] the mock did not come up on ${mockUrl}; is port ${MOCK_PORT} taken?`);
  process.exit(1);
}

const seeded = new Set();
const adb = await findAdb();

async function watchDevices() {
  for (const { udid, name } of await bootedSimulators()) {
    // A fresh simulator has no "On My iPhone" storage until something opens
    // the Files provider (the app's picker will); keep trying until then.
    if (seeded.has(udid) || !(await seedSimulator(udid))) continue;
    seeded.add(udid);
    say(`${name}: fixtures in Files › On My iPhone › Statement fixtures`);
  }
  if (!adb) return;
  for (const serial of await androidDevices(adb)) {
    if (await ensureReverse(adb, serial)) say(`${serial}: adb reverse tcp:${MOCK_PORT} → mock`);
    if (seeded.has(serial)) continue;
    seeded.add(serial);
    if (await pushAndroidFixtures(adb, serial)) say(`${serial}: fixtures in Download/Statement fixtures`);
    else seeded.delete(serial);
  }
}

// Polls every few seconds, never two rounds at once.
async function keepWatching(signal) {
  while (!signal.aborted) {
    await watchDevices().catch(() => {});
    await sleep(3000);
  }
}

const [command = "start", ...args] = process.argv.slice(2);
const rest = args.filter((arg) => arg !== "--lan");
const expoArgs = command === "start" ? ["start", "--dev-client", ...rest] : [command, ...rest];

let lanUrl = null;
if (args.includes("--lan") || args.includes("--device")) {
  const address = lanAddress();
  if (!address) {
    console.error("[dev] no local network address found; the phone and the Mac must share a Wi-Fi network");
    process.exit(1);
  }
  lanUrl = `http://${address}:${MOCK_PORT}`;
  say(`phone mode: the mock is open to the local network at ${lanUrl} (synthetic data only)`);
}

await ensureOversizeFixture();
const mock = await startMock(lanUrl);

const expo = spawn(process.execPath, [join(root, "node_modules", "expo", "bin", "cli"), ...expoArgs], {
  cwd: root,
  // Read when the bundle is built; with a stale Metro cache add --clear.
  env: lanUrl ? { ...process.env, EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL ?? lanUrl } : process.env,
  stdio: "inherit",
});
const watching = new AbortController();
void keepWatching(watching.signal);

// Ctrl+C reaches Expo too; wait for it to wind down, then take the mock along.
process.on("SIGINT", () => {});
process.on("SIGTERM", () => expo.kill("SIGTERM"));
expo.on("exit", (code) => {
  watching.abort();
  mock?.kill();
  process.exit(code ?? 0);
});
