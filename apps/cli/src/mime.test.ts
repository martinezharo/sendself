import { describe, expect, it } from "vitest";
import { FALLBACK_MIME, mimeFor } from "./mime";

describe("mimeFor", () => {
  it("knows common types, whatever the case of the extension", () => {
    expect(mimeFor("report.pdf")).toBe("application/pdf");
    expect(mimeFor("IMG_0001.JPG")).toBe("image/jpeg");
    expect(mimeFor("archive.tar.gz")).toBe("application/gzip");
  });

  it("falls back to opaque bytes for anything it cannot tell", () => {
    expect(mimeFor("Makefile")).toBe(FALLBACK_MIME);
    expect(mimeFor(".env")).toBe(FALLBACK_MIME);
    expect(mimeFor("trailing.")).toBe(FALLBACK_MIME);
    expect(mimeFor("data.unknownext")).toBe(FALLBACK_MIME);
  });
});
