/**
 * Hand a blob to the browser's downloads under `name`. Shared by every place
 * that saves something this device already holds in the clear: a message's
 * attachment and a vault file.
 */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
