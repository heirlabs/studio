/**
 * One-time migration of user data from the pre-rename ("Grok Studio") paths.
 *
 * Only ever runs when the destination does not exist, and only ever renames —
 * nothing is deleted or overwritten, so the step is reversible by renaming back.
 */
import fs from "fs";
import path from "path";
import os from "os";

/** Directory names this product used before the rename. */
export const LEGACY_APP_DIR_NAMES = ["grok-studio", "Grok Studio"];

/**
 * Rename `from` to `to` when `to` is absent and `from` holds something.
 * @returns {{ migrated: boolean, from?: string, to?: string, reason?: string }}
 */
export function migrateDir(from, to) {
  if (!from || !to) return { migrated: false, reason: "missing path" };
  if (fs.existsSync(to)) return { migrated: false, reason: "destination exists" };
  if (!fs.existsSync(from)) return { migrated: false, reason: "nothing to migrate" };
  if (!fs.statSync(from).isDirectory()) {
    return { migrated: false, reason: "source is not a directory" };
  }
  if (fs.readdirSync(from).length === 0) {
    return { migrated: false, reason: "source is empty" };
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return { migrated: true, from, to };
}

/**
 * Move ~/.grok-studio (settings + keybindings) to ~/.heir-studio.
 */
export function migrateHomeConfig(home = os.homedir(), log) {
  const result = migrateDir(
    path.join(home, ".grok-studio"),
    path.join(home, ".heir-studio"),
  );
  if (result.migrated) {
    log?.info?.("migrate.home_config", { from: result.from, to: result.to });
  }
  return result;
}

/**
 * Move the Electron user-data directory from any legacy product name.
 * @param appSupportDir e.g. ~/Library/Application Support
 * @param currentName   e.g. "heir-studio"
 */
export function migrateAppSupport(appSupportDir, currentName, log) {
  const to = path.join(appSupportDir, currentName);
  for (const legacy of LEGACY_APP_DIR_NAMES) {
    if (legacy === currentName) continue;
    const result = migrateDir(path.join(appSupportDir, legacy), to);
    if (result.migrated) {
      log?.info?.("migrate.app_support", { from: result.from, to: result.to });
      return result;
    }
  }
  return { migrated: false, reason: "no legacy app data" };
}
