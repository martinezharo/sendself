/**
 * The media type a receiving device opens a file with, guessed from its
 * extension the way a browser file picker would. It travels inside the
 * encrypted metadata, so guessing wrong only costs a less helpful "open with".
 */

const TYPES: Record<string, string> = {
  // Documents
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  htm: "text/html",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  log: "text/plain",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  epub: "application/epub+zip",
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  // Audio and video
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  // Archives
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  // Code
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/plain",
  py: "text/x-python",
  sh: "application/x-sh",
  css: "text/css",
  sql: "application/sql",
  diff: "text/x-diff",
  patch: "text/x-diff",
};

export const FALLBACK_MIME = "application/octet-stream";

export function mimeFor(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return FALLBACK_MIME;
  return TYPES[fileName.slice(dot + 1).toLowerCase()] ?? FALLBACK_MIME;
}
