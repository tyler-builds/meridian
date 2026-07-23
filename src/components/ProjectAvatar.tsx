import { cn } from "@/lib/utils";

/**
 * Up to two uppercase initials for a project with no favicon. Multi-word names
 * take the first letter of the first two words (`"my-app"` → `MA`); single
 * words take their first two letters (`"meridian"` → `ME`).
 */
export function initials(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  const word = parts[0] ?? "";
  return (word.slice(0, 2) || "?").toUpperCase();
}

/**
 * A project's icon: its detected favicon when it has one, otherwise a generated
 * initials avatar (replacing the old generic folder glyph). Used in the
 * horizontal tab strip and the vertical rail, at a few sizes.
 */
export function ProjectAvatar({
  favicon,
  name,
  size,
  badgeSize = size,
  active = false,
  className,
}: {
  favicon?: string | null;
  name: string;
  /** Pixel size of the favicon image. */
  size: number;
  /** Pixel size of the initials badge; defaults to `size`. */
  badgeSize?: number;
  active?: boolean;
  className?: string;
}) {
  if (favicon) {
    return (
      <img
        src={favicon}
        alt=""
        style={{ width: size, height: size }}
        className={cn("shrink-0 rounded-[3px] object-contain", className)}
      />
    );
  }
  return (
    <span
      style={{
        width: badgeSize,
        height: badgeSize,
        fontSize: Math.max(8, Math.round(badgeSize * 0.42)),
      }}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[4px] bg-bg-active font-semibold leading-none tracking-tight",
        active ? "text-fg" : "text-fg-subtle",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
