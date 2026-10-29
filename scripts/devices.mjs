// Booted iOS simulators and connected Android devices: reach the mock and
// find the kit's fixtures in the system file picker. Everything here is best
// effort and bounded by timeouts, so a slow device never holds up Expo.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const KIT = join(root, "kit");
export const MOCK_PORT = 8787;

const FIXTURES = ["statement.csv", "statement.pdf", "spoofed.pdf", "oversize.csv"];
const FOLDER = "Statement fixtures";

const execFileAsync = promisify(execFile);

async function run(command, args, timeout = 15_000) {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: "utf8", timeout });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}

// The kit's own command (`npm run fixtures:oversize`); the kit gitignores the file.
export async function ensureOversizeFixture() {
  if (existsSync(join(KIT, "fixtures", "oversize.csv"))) return;
  await execFileAsync(process.execPath, ["make-oversize.mjs"], { cwd: KIT });
}

function fixturePaths() {
  return FIXTURES.map((name) => join(KIT, "fixtures", name)).filter(existsSync);
}

// Android Studio's default SDK location per OS, unless ANDROID_HOME says otherwise.
function defaultSdk() {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Android", "Sdk");
  if (process.platform === "darwin") return join(homedir(), "Library", "Android", "sdk");
  return join(homedir(), "Android", "Sdk");
}

export async function findAdb() {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? defaultSdk();
  const candidate = join(sdk, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
  if (existsSync(candidate)) return candidate;
  return (await run("adb", ["version"])).ok ? "adb" : null;
}

export async function androidDevices(adb) {
  const { stdout } = await run(adb, ["devices"]);
  return stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === "device")
    .map(([serial]) => serial);
}

// Lets the app use http://127.0.0.1:8787 on an emulator or a USB device.
// Resolves to true when the rule had to be (re)created.
export async function ensureReverse(adb, serial) {
  const list = await run(adb, ["-s", serial, "reverse", "--list"]);
  if (list.ok && list.stdout.includes(`tcp:${MOCK_PORT}`)) return false;
  return (await run(adb, ["-s", serial, "reverse", `tcp:${MOCK_PORT}`, `tcp:${MOCK_PORT}`])).ok;
}

// Into Download/Statement fixtures. They show up in the picker under the
// device's storage root at once, and under Downloads after a media scan.
export async function pushAndroidFixtures(adb, serial) {
  const target = `/sdcard/Download/${FOLDER}`;
  await run(adb, ["-s", serial, "shell", "mkdir", "-p", `'${target}'`]);
  for (const path of fixturePaths()) {
    const file = `${target}/${basename(path)}`;
    if (!(await run(adb, ["-s", serial, "push", path, file], 60_000)).ok) return false;
    await run(adb, ["-s", serial, "shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", `'file://${file}'`]);
  }
  return true;
}

export async function bootedSimulators() {
  if (process.platform !== "darwin") return [];
  const { ok, stdout } = await run("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
  if (!ok) return [];
  try {
    return Object.values(JSON.parse(stdout).devices)
      .flat()
      .filter((device) => device.state === "Booted")
      .map((device) => ({ udid: device.udid, name: device.name }));
  } catch {
    return [];
  }
}

// Into Files › On My iPhone › Statement fixtures.
export async function seedSimulator(udid) {
  const { stdout } = await run("xcrun", ["simctl", "get_app_container", udid, "com.apple.DocumentsApp", "groups"]);
  const line = stdout.split("\n").find((entry) => entry.startsWith("group.com.apple.FileProvider.LocalStorage"));
  if (!line) return false;
  const target = join(line.split("\t")[1].trim(), "File Provider Storage", FOLDER);
  await mkdir(target, { recursive: true });
  for (const path of fixturePaths()) await copyFile(path, join(target, basename(path)));
  return true;
}
