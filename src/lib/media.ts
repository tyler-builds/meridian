/**
 * Maps file extensions to previewable media so the editor can show an image or
 * play a video instead of loading its bytes as text. SVG is intentionally left
 * out — it's XML and usually wants to be edited as source in the code editor.
 */

export type MediaKind = "image" | "video";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

const VIDEO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  webm: "video/webm",
  ogv: "video/ogg",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
};

/**
 * Classify a file by extension for preview. Returns the media kind and the MIME
 * type to tag its Blob with, or `null` when the file isn't previewable media
 * (so it opens in the text editor as before).
 */
export function mediaInfo(rel: string): { kind: MediaKind; mime: string } | null {
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  if (ext in IMAGE_MIME) return { kind: "image", mime: IMAGE_MIME[ext] };
  if (ext in VIDEO_MIME) return { kind: "video", mime: VIDEO_MIME[ext] };
  return null;
}
