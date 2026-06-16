import type { Options, Plugin } from "prettier";

import { prettierFormatLocal, readPrettierConfigFiles } from "@/lib/tauri";

/**
 * Prettier integration for the code editor. Formatting follows a hybrid path:
 *
 *  1. The project's *own* installed Prettier, run in the backend via
 *     `--stdin-filepath`. This honors every config form exactly as the project
 *     expects — JS/TS configs, plugins, `extends`, `overrides`, and
 *     `.prettierignore`.
 *  2. If the project has no local Prettier, fall back to `prettier/standalone`
 *     bundled in the app, combined with a best-effort resolver that reads the
 *     project's declarative config files (.prettierrc / .json / .json5 / .yaml /
 *     package.json#prettier) and applies their options + matching overrides.
 *
 * The standalone parsers are imported lazily — only when a file of a given
 * language is first formatted by the fallback — so none of Prettier's ~1MB of
 * parsers land in the initial bundle.
 */

/** Pull the plugin object out of a dynamically imported module. */
const plugin = (m: unknown): Plugin =>
  ((m as { default?: Plugin }).default ?? (m as Plugin));

interface FormatTarget {
  /** Prettier parser name (e.g. "typescript"). */
  parser: string;
  /** Lazily load the plugins this parser depends on. */
  plugins: () => Promise<Plugin[]>;
}

// Keyed by Monaco language id. Monaco reports JSX/TSX as "javascript"/
// "typescript", so those parsers cover the React file types too.
const TARGETS: Record<string, FormatTarget> = {
  typescript: {
    parser: "typescript",
    plugins: async () => [
      plugin(await import("prettier/plugins/estree")),
      plugin(await import("prettier/plugins/typescript")),
    ],
  },
  javascript: {
    parser: "babel",
    plugins: async () => [
      plugin(await import("prettier/plugins/estree")),
      plugin(await import("prettier/plugins/babel")),
    ],
  },
  json: {
    parser: "json",
    plugins: async () => [
      plugin(await import("prettier/plugins/estree")),
      plugin(await import("prettier/plugins/babel")),
    ],
  },
  css: {
    parser: "css",
    plugins: async () => [plugin(await import("prettier/plugins/postcss"))],
  },
  scss: {
    parser: "scss",
    plugins: async () => [plugin(await import("prettier/plugins/postcss"))],
  },
  less: {
    parser: "less",
    plugins: async () => [plugin(await import("prettier/plugins/postcss"))],
  },
  html: {
    parser: "html",
    plugins: async () => [plugin(await import("prettier/plugins/html"))],
  },
  markdown: {
    parser: "markdown",
    plugins: async () => [plugin(await import("prettier/plugins/markdown"))],
  },
  yaml: {
    parser: "yaml",
    plugins: async () => [plugin(await import("prettier/plugins/yaml"))],
  },
};

/** Monaco language ids the bundled fallback formatter can handle. */
export const SUPPORTED_FORMAT_LANGUAGES = Object.keys(TARGETS);

// --- Model → file mapping -------------------------------------------------
//
// Monaco's formatting providers only receive the text model, but resolving a
// project's Prettier (local binary + config) needs the file's real location.
// EditorPanel registers each model's {root, rel} here so the provider can look
// it up by model URI.

const MODEL_FILES = new Map<string, { root: string; rel: string }>();

export function registerModelFile(
  uriKey: string,
  root: string,
  rel: string,
): void {
  MODEL_FILES.set(uriKey, { root, rel });
}

export function unregisterModelFile(uriKey: string): void {
  MODEL_FILES.delete(uriKey);
}

export function getModelFile(
  uriKey: string,
): { root: string; rel: string } | undefined {
  return MODEL_FILES.get(uriKey);
}

// --- Orchestration --------------------------------------------------------

/**
 * Format a document, preferring the project's own Prettier and falling back to
 * the bundled standalone Prettier + declarative-config resolver. Returns the
 * formatted source, or `null` when there is nothing to do (unsupported
 * language, no formatter, ignored file, or a formatting error — all of which
 * leave the buffer untouched).
 */
export async function formatDocument(params: {
  code: string;
  languageId: string;
  /** The model's project file, when it maps to one. */
  file?: { root: string; rel: string };
  /** Editor indentation, used as defaults the project's config can override. */
  editorIndent: { tabWidth: number; useTabs: boolean };
}): Promise<string | null> {
  const { code, languageId, file, editorIndent } = params;

  // 1. Project-local Prettier — authoritative when present.
  if (file) {
    try {
      const res = await prettierFormatLocal(`${file.root}/${file.rel}`, code);
      if (res.source === "local") return res.formatted;
      // res.source === "none": no local Prettier, fall through to the bundle.
    } catch (e) {
      // The project's Prettier ran and rejected (e.g. a syntax error). Don't
      // second-guess it with the bundled formatter — leave the buffer as-is.
      console.warn(`Prettier (project) could not format ${file.rel}:`, e);
      return null;
    }
  }

  // 2. Bundled standalone Prettier + best-effort config resolution.
  const target = TARGETS[languageId];
  if (!target) return null;

  const config = file
    ? await resolveDeclaredConfig(file.root, file.rel)
    : {};
  const [prettier, plugins] = await Promise.all([
    import("prettier/standalone"),
    target.plugins(),
  ]);

  const opts: Options = {
    tabWidth: editorIndent.tabWidth,
    useTabs: editorIndent.useTabs,
  };
  // The project's options win over the editor defaults; our parser/plugins are
  // then re-pinned so a stray `parser`/`plugins` in the config can't break us.
  Object.assign(opts, config);
  opts.parser = target.parser;
  opts.plugins = plugins;

  try {
    return await prettier.format(code, opts);
  } catch (e) {
    console.warn(`Prettier (bundled) could not format ${file?.rel ?? languageId}:`, e);
    return null;
  }
}

// --- Declarative config resolution (fallback only) ------------------------

/**
 * Find the nearest declarative Prettier config for a file and return its
 * options with any matching `overrides` merged in. Returns `{}` when there is
 * no usable config. JS/TS configs can't be evaluated here — that's exactly the
 * case the project-local Prettier path handles.
 */
async function resolveDeclaredConfig(
  root: string,
  rel: string,
): Promise<Record<string, unknown>> {
  let files;
  try {
    files = await readPrettierConfigFiles(root, rel);
  } catch {
    return {};
  }
  if (files.length === 0) return {};

  const [json5Mod, yamlMod] = await Promise.all([
    import("json5"),
    import("yaml"),
  ]);
  const JSON5 = json5Mod.default;
  const YAML = yamlMod;

  for (const f of files) {
    const name = f.rel.split("/").pop() ?? f.rel;
    const parsed = parseConfig(name, f.contents, JSON5, YAML);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return applyOverrides(parsed as Record<string, unknown>, rel);
    }
  }
  return {};
}

/** Parse a single config file by name, or null if it yields no config. */
function parseConfig(
  name: string,
  contents: string,
  JSON5: { parse: (s: string) => unknown },
  YAML: { parse: (s: string) => unknown },
): unknown {
  try {
    if (name === "package.json") {
      const pkg = JSON.parse(contents) as { prettier?: unknown };
      // A string value is a path to a shared config module — not resolvable in
      // the fallback path, so treat package.json as having no usable config.
      return pkg.prettier && typeof pkg.prettier === "object"
        ? pkg.prettier
        : null;
    }
    if (name.endsWith(".yaml") || name.endsWith(".yml")) {
      return YAML.parse(contents);
    }
    if (name.endsWith(".json") || name.endsWith(".json5")) {
      return JSON5.parse(contents);
    }
    // `.prettierrc` is JSON-or-YAML: try JSON (via JSON5) first, then YAML.
    try {
      return JSON5.parse(contents);
    } catch {
      return YAML.parse(contents);
    }
  } catch (e) {
    console.warn(`Could not parse Prettier config "${name}":`, e);
    return null;
  }
}

/** Merge `overrides` whose `files` glob matches `rel` over the base options. */
function applyOverrides(
  config: Record<string, unknown>,
  rel: string,
): Record<string, unknown> {
  const { overrides, ...base } = config;
  if (!Array.isArray(overrides)) return base;

  let merged: Record<string, unknown> = { ...base };
  for (const ov of overrides) {
    if (!ov || typeof ov !== "object") continue;
    const files = (ov as { files?: unknown }).files;
    const patterns = Array.isArray(files) ? files : [files];
    const matched = patterns.some(
      (p) => typeof p === "string" && matchGlob(p, rel),
    );
    if (matched) {
      const options = (ov as { options?: unknown }).options;
      if (options && typeof options === "object") {
        merged = { ...merged, ...(options as Record<string, unknown>) };
      }
    }
  }
  return merged;
}

/**
 * Minimal glob match for Prettier override `files` patterns. Supports `*`,
 * double-star, `?`, and `{a,b}` brace lists — which covers essentially all
 * real-world override patterns (e.g. "*.md", "*.{ts,tsx}", recursive globs).
 * Matches against both the full relative path and the basename. Complex
 * patterns are fully honored by the project-local Prettier path; this is the
 * fallback only.
 */
function matchGlob(pattern: string, rel: string): boolean {
  try {
    const re = globToRegExp(pattern);
    const base = rel.split("/").pop() ?? rel;
    return re.test(rel) || re.test(base);
  } catch {
    return false;
  }
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      re += "(?:";
    } else if (c === "}") {
      re += ")";
    } else if (c === ",") {
      re += "|";
    } else if (".+()|^$\\[]".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}
