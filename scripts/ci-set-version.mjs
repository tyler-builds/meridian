// Stamps the app version from a pushed git tag (e.g. "v1.2.3" -> "1.2.3") into
// the three places that carry it, so the built installers AND the in-app About
// tab all report the tag. Run in CI before `tauri build`.
//
//   node scripts/ci-set-version.mjs v1.2.3
//   RELEASE_TAG=v1.2.3 node scripts/ci-set-version.mjs
//
// tauri.conf.json is the one that matters at runtime — getVersion() reads it.
// package.json and Cargo.toml are kept in sync so nothing reports a stale
// number. None of these writes are committed; they live only in the CI checkout.
import { readFileSync, writeFileSync } from "node:fs";

const raw = process.env.RELEASE_TAG ?? process.argv[2];
if (!raw) {
  console.error("No tag provided (set RELEASE_TAG or pass it as an argument).");
  process.exit(1);
}

const version = raw.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
  console.error(
    `Tag "${raw}" is not a plain version. Use vMAJOR.MINOR.PATCH (e.g. v1.2.3) — ` +
      "macOS bundles reject pre-release suffixes in CFBundleShortVersionString.",
  );
  process.exit(1);
}

// tauri.conf.json — the source getVersion() reads at runtime.
const confPath = "src-tauri/tauri.conf.json";
const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = version;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

// package.json — cosmetic, but keeps `npm` and the repo honest.
const pkgPath = "package.json";
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// Cargo.toml — bump the first `version = "..."` (the [package] one). The
// `rust-version = "..."` line is unaffected by the anchored ^version match.
const cargoPath = "src-tauri/Cargo.toml";
const cargo = readFileSync(cargoPath, "utf8").replace(
  /^version = "[^"]*"/m,
  `version = "${version}"`,
);
writeFileSync(cargoPath, cargo);

console.log(`Stamped version ${version} from tag ${raw}.`);
