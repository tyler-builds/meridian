import {
  createFileTreeIconResolver,
  getBuiltInSpriteSheet,
} from "@pierre/trees";

// Reuse trees.software's colored built-in icon set so tabs match the file tree.
const ICON_SET = "complete" as const;
const resolver = createFileTreeIconResolver({ set: ICON_SET, colored: true });

// The built-in icons are `currentColor`; the tree colors them per file type via
// a token -> palette mapping. Mirror that here (dark-theme palette values) and
// apply the color directly, since the tree's CSS lives in its shadow DOM.
const PALETTE: Record<string, string> = {
  blue: "#69b1ff",
  cyan: "#68cdf2",
  gray: "#adadb1",
  green: "#5ecc71",
  indigo: "#9d6afb",
  mauve: "#79697b",
  orange: "#ffa359",
  pink: "#ff678d",
  purple: "#d568ea",
  red: "#ff6762",
  teal: "#64d1db",
  vermilion: "#d5512f",
  yellow: "#ffd452",
};

const TOKEN_PALETTE: Record<string, string> = {
  default: "gray", astro: "purple", babel: "yellow", bash: "green",
  biome: "blue", bootstrap: "indigo", browserslist: "yellow", bun: "mauve",
  c: "blue", cpp: "blue", claude: "orange", css: "indigo", database: "purple",
  docker: "blue", eslint: "indigo", git: "vermilion", go: "cyan",
  graphql: "pink", html: "orange", image: "pink", javascript: "yellow",
  json: "orange", markdown: "green", mcp: "teal", npm: "red", oxc: "cyan",
  postcss: "red", prettier: "teal", python: "blue", react: "cyan", ruby: "red",
  rust: "orange", sass: "pink", svg: "orange", svelte: "red", svgo: "green",
  swift: "orange", table: "teal", text: "gray", tailwind: "cyan",
  terraform: "indigo", typescript: "blue", vite: "purple", vscode: "blue",
  vue: "green", wasm: "indigo", webpack: "blue", yml: "red", zig: "orange",
  zip: "orange",
};

function tokenColor(token: string | undefined): string {
  const palette = (token && TOKEN_PALETTE[token]) || "gray";
  return PALETTE[palette] ?? PALETTE.gray;
}

let spriteInjected = false;
function ensureSprite() {
  if (spriteInjected || typeof document === "undefined") return;
  spriteInjected = true;
  const container = document.createElement("div");
  container.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  container.setAttribute("aria-hidden", "true");
  container.innerHTML = getBuiltInSpriteSheet(ICON_SET);
  document.body.appendChild(container);
}
ensureSprite();

/** A colored file-type icon (same set as the file tree), keyed off the path. */
export function FileTypeIcon({
  path,
  size = 14,
  className,
}: {
  path: string;
  size?: number;
  className?: string;
}) {
  const { name, token } = resolver.resolveIcon("file-tree-icon-file", path);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      style={{ color: tokenColor(token) }}
      aria-hidden="true"
    >
      <use href={`#${name}`} />
    </svg>
  );
}
