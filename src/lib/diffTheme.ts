import {
  registerCustomTheme,
  type ThemeRegistrationResolved,
} from "@pierre/diffs";

/**
 * Name of the custom @pierre/diffs theme registered below. Pass this as
 * `options.theme` to `PatchDiff`.
 */
export const DIFF_THEME = "meridian-dark";

/**
 * Diff add/remove accent colors — also used for the per-file +/- line counts in
 * the panel UI so they stay in sync with the rendered diff.
 */
export const DIFF_ADDITION_COLOR = "#3fb950";
export const DIFF_DELETION_COLOR = "#e5534b";

/**
 * Register a diff theme tuned to the app's palette. It reuses Pierre Dark's
 * rich syntax token colors (so highlighting stays high quality) but overrides
 * the editor background/foreground to the app's `--color-bg` / `--color-fg`,
 * and softens the git add/remove/modify colors to fit the muted, teal-accented
 * UI. `@pierre/diffs` derives the diff background from `editor.background` and
 * the change colors from the `gitDecoration.*` color keys.
 *
 * This mirrors exactly how the library registers its own `pierre-dark` theme
 * (dynamic-import the base theme, spread, rename), so it uses a supported path.
 */
registerCustomTheme(DIFF_THEME, async () => {
  const { default: base } = await import("@pierre/theme/pierre-dark");
  return {
    ...base,
    name: DIFF_THEME,
    type: "dark",
    colors: {
      ...base.colors,
      "editor.background": "#1c1c1c",
      "editor.foreground": "#e5e5e5",
      foreground: "#e5e5e5",
      "gitDecoration.addedResourceForeground": DIFF_ADDITION_COLOR,
      "gitDecoration.deletedResourceForeground": DIFF_DELETION_COLOR,
      "gitDecoration.modifiedResourceForeground": "#2fa39a",
    },
  } as unknown as ThemeRegistrationResolved;
});
