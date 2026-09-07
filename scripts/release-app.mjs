#!/usr/bin/env node
/** Build a signed updater archive and publish GitHub Releases. */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const keyPath = join(homedir(), ".grotesque", "tauri-updater.key");
if (!existsSync(keyPath)) {
  console.error("Missing updater key: ~/.grotesque/tauri-updater.key");
  process.exit(1);
}

process.env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8");
process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";

execFileSync("npx", ["tauri", "build", "--bundles", "app"], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

const version = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
).version;
const macos = join(root, "src-tauri/target/release/bundle/macos");
const app = join(macos, "Grotesque.app");
const destDir = join(homedir(), "Applications");
const dest = join(destDir, "Grotesque.app");
mkdirSync(destDir, { recursive: true });
rmSync(dest, { recursive: true, force: true });
cpSync(app, dest, { recursive: true });

const tar = join(macos, "Grotesque.app.tar.gz");
const sigPath = join(macos, "Grotesque.app.tar.gz.sig");
const latest = join(macos, "latest.json");
const tag = `v${version}`;
const repo = process.env.GROTESQUE_RELEASE_REPO || "justsaiiint/grotesque";

if (!existsSync(tar) || !existsSync(sigPath)) {
  console.error("Missing updater archive. The keyed Tauri build should write Grotesque.app.tar.gz and .sig.");
  process.exit(1);
}

const signature = readFileSync(sigPath, "utf8").trim();
const url = `https://github.com/${repo}/releases/download/${tag}/Grotesque.app.tar.gz`;
writeFileSync(
  latest,
  JSON.stringify(
    {
      version,
      notes: `Grotesque ${version}`,
      pub_date: new Date().toISOString(),
      platforms: {
        "darwin-aarch64": {
          signature,
          url,
        },
      },
    },
    null,
    2,
  ) + "\n",
);

execFileSync(
  "gh",
  [
    "release",
    "create",
    tag,
    tar,
    sigPath,
    latest,
    "--repo",
    repo,
    "--title",
    `Grotesque ${version}`,
    "--notes",
    `Grotesque ${version}`,
  ],
  { stdio: "inherit" },
);
