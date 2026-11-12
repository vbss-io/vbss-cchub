import { upgradeBackupIfNeeded } from "./backups.js";
import { appVersion } from "./config.js";

const entry = upgradeBackupIfNeeded(appVersion);
if (entry) console.log(`upgrade backup written: ${entry.file}`);
