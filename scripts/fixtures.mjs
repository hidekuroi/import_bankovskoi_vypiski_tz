// `npm run fixtures`: put the kit's test files where the system picker finds
// them, on every booted iOS simulator and connected Android device.
import {
  androidDevices,
  bootedSimulators,
  ensureOversizeFixture,
  findAdb,
  pushAndroidFixtures,
  seedSimulator,
} from "./devices.mjs";

await ensureOversizeFixture();
let count = 0;

for (const { udid, name } of await bootedSimulators()) {
  if (!(await seedSimulator(udid))) continue;
  console.log(`${name}: Files › On My iPhone › Statement fixtures`);
  count += 1;
}

const adb = await findAdb();
for (const serial of adb ? await androidDevices(adb) : []) {
  if (!(await pushAndroidFixtures(adb, serial))) continue;
  console.log(`${serial}: Download/Statement fixtures`);
  count += 1;
}

if (count === 0) console.log("No booted simulator or connected Android device.");
