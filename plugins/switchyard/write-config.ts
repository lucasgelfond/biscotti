import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stringify } from "smol-toml";
import { config, secrets } from "./index.ts";

// Switchyard's switchyard.toml and its keys (switchyard.env), from the settings, for its user (uid 1000) alone;
// compose.yaml runs it before Switchyard starts. With the bifrost plugin on (biscotti.json), the gateway is Bifrost.
//   node plugins/switchyard/write-config.ts <dir> [biscotti.json]
const [dir, plugins] = process.argv.slice(2) as [string, string | undefined];
const bifrost = !!plugins && existsSync(plugins) && (JSON.parse(readFileSync(plugins, "utf8")).plugins as string[]).includes("bifrost");
const quoted = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/switchyard.toml`, stringify(config(process.env, bifrost)));
writeFileSync(`${dir}/switchyard.env`, Object.entries(secrets(process.env, bifrost)).map(([k, v]) => `${k}=${quoted(v)}\n`).join(""));
for (const file of ["switchyard.toml", "switchyard.env"]) chmodSync(`${dir}/${file}`, 0o600);
if (process.getuid?.() === 0) for (const path of [dir, `${dir}/switchyard.toml`, `${dir}/switchyard.env`]) chownSync(path, 1000, 1000);
console.log(`switchyard: wrote ${dir}/switchyard.toml${bifrost ? " (through Bifrost)" : ""}`);
