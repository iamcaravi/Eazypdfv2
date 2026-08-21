import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { PDFDocument, degrees } from "pdf-lib";
import { describe, expect, it } from "vitest";

const FIXTURES = dirname(fileURLToPath(new URL("./fixtures/manifest.json", import.meta.url)));

function fixture(name) {
  return readFileSync(resolve(FIXTURES, name));
}

describe("deterministic document fixtures", () => {
  it("matches every recorded size and SHA-256", () => {
    const manifest = JSON.parse(fixture("manifest.json").toString("utf8"));
    for (const [name, expected] of Object.entries(manifest)) {
      const bytes = fixture(name);
      expect(bytes.length, name).toBe(expected.bytes);
      expect(createHash("sha256").update(bytes).digest("hex"), name).toBe(expected.sha256);
    }
  });

  it("performs a real PDF rotate/save/reopen flow", async () => {
    const pdf = await PDFDocument.load(fixture("multipage.pdf"));
    expect(pdf.getPageCount()).toBe(3);
    pdf.getPage(0).setRotation(degrees(90));

    const saved = await pdf.save();
    const reopened = await PDFDocument.load(saved);
    expect(reopened.getPageCount()).toBe(3);
    expect(reopened.getPage(0).getRotation().angle).toBe(90);
  });

  it("performs a real PDF merge flow", async () => {
    const output = await PDFDocument.create();
    for (const name of ["valid.pdf", "multipage.pdf"]) {
      const input = await PDFDocument.load(fixture(name));
      const pages = await output.copyPages(input, input.getPageIndices());
      pages.forEach((page) => output.addPage(page));
    }

    const reopened = await PDFDocument.load(await output.save());
    expect(reopened.getPageCount()).toBe(4);
  });

  it("embeds a real PNG into a PDF", async () => {
    const output = await PDFDocument.create();
    const image = await output.embedPng(fixture("simple.png"));
    const page = output.addPage([100, 100]);
    page.drawImage(image, { x: 10, y: 10, width: 80, height: 80 });

    const reopened = await PDFDocument.load(await output.save());
    expect(reopened.getPageCount()).toBe(1);
  });

  it.each([
    ["minimal.docx", "word/document.xml"],
    ["minimal.xlsx", "xl/worksheets/sheet1.xml"],
    ["minimal.pptx", "ppt/slides/slide1.xml"],
  ])("opens %s as a valid OOXML package", async (name, requiredPart) => {
    const archive = await JSZip.loadAsync(fixture(name));
    expect(archive.file("[Content_Types].xml")).toBeTruthy();
    expect(archive.file(requiredPart)).toBeTruthy();
  });

  it("classifies malformed and empty PDF fixtures without false success", async () => {
    const recoveredMalformed = await PDFDocument.load(fixture("malformed.pdf"));
    expect(() => recoveredMalformed.getPageCount()).toThrow();
    await expect(PDFDocument.load(fixture("empty.bin"))).rejects.toThrow();
  });
});
