import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * True when running on macOS. Drives platform-specific chrome — on macOS the
 * window uses the native title bar (traffic lights) instead of our custom
 * min/max/close controls, so callers branch on this to render the right UI.
 */
export const isMac =
  typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
