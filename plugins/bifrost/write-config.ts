import { chmodSync, chownSync, mkdirSync, writeFileSync } from "node:fs";
import { config } from "./index.ts";

// Bifrost's config.json from the settings, for its user (uid 1000) alone; compose.yaml runs it before Bifrost starts.
//   node plugins/bifrost/write-config.ts <dir>
const dir = process.argv[2]!;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/config.json`, JSON.stringify(config(process.env), null, 2));
chmodSync(`${dir}/config.json`, 0o600);
if (process.getuid?.() === 0) for (const path of [dir, `${dir}/config.json`]) chownSync(path, 1000, 0);
