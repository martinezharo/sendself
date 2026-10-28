/**
 * Putting an image on the system clipboard.
 *
 * The async clipboard API is only guaranteed to accept `image/png`: Chromium
 * rejects every other image type outright, so a JPEG or WebP attachment has to
 * be re-encoded before it can be copied. PNG is passed through untouched.
 */

const CLIPBOARD_IMAGE_TYPE = "image/png";

/** Whether this browser can write images to the clipboard at all. */
export function canCopyImages(): boolean {
  return (
    typeof ClipboardItem !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.clipboard?.write === "function"
  );
}

/** Re-encode any image the browser can decode as PNG. */
async function toPng(blob: Blob): Promise<Blob> {
  if (blob.type === CLIPBOARD_IMAGE_TYPE) return blob;

  // An <img> rather than createImageBitmap: it is the one decoder that also
  // takes SVG, and an attachment can be one.
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No 2d canvas context");
    context.drawImage(image, 0, 0);

    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (png) => (png ? resolve(png) : reject(new Error("Couldn't encode the image"))),
        CLIPBOARD_IMAGE_TYPE,
      ),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Copy an image blob to the clipboard. Rejects if the browser refuses.
 *
 * The clipboard item is handed a *promise* for the PNG instead of the finished
 * blob: Safari only honours a write made inside the user gesture, and the
 * conversion above is asynchronous.
 */
export async function copyImageBlob(blob: Blob): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ [CLIPBOARD_IMAGE_TYPE]: toPng(blob) })]);
}
