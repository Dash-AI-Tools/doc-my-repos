// Preload for scripts/installer-e2e.sh: `node --import scripts/installer-e2e-host.mjs ...`.
//
// The installer chooses where the GitHub App key lives from the host (a file on Docker Desktop or
// when the user id is 1000, otherwise inline in .env). The end-to-end test must exercise both
// layouts on one machine, so this preload makes the installer see the platform and user id named
// by E2E_FAKE_PLATFORM and E2E_FAKE_UID. It changes nothing else and is test support only.
const platform = process.env.E2E_FAKE_PLATFORM;
const uid = process.env.E2E_FAKE_UID;

if (platform) {
  Object.defineProperty(process, "platform", { value: platform });
}
if (uid !== undefined && uid !== "") {
  const value = Number(uid);
  if (!Number.isInteger(value)) throw new Error("E2E_FAKE_UID must be an integer");
  process.getuid = () => value;
}
