import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const dependencyBase = process.env.YOYO_DEPENDENCY_ROOT
  ? resolve(process.env.YOYO_DEPENDENCY_ROOT, "package.json")
  : import.meta.url;
const require = createRequire(dependencyBase);
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const JSZip = require("jszip");

const CHECK = process.argv.includes("--check");
const FIXED_DATE = new Date("2000-01-01T00:00:00.000Z");
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR42mP8z8AARMAgYKSAAAMAAB0ABfob8TUAAAAASUVORK5CYII=",
  "base64"
);

// Standard PNG CRC32 (ISO 3309 / ITU-T V.42, the table PNG's own spec
// gives as its reference implementation) - needed because Node's zlib
// module deflate/inflates but exposes no CRC32, and every PNG chunk
// requires one.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
/** A real, solid-color RGB PNG at genuinely testable pixel dimensions -
 *  simple.png (2x2) is too small to prove a crop actually shrank the
 *  output (any real crop of a 2x2 source already rounds to <=2px, true
 *  whether or not cropping genuinely ran). */
function makeSolidPng(width, height, [r, g, b]) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // color type: truecolor (RGB)
  // remaining 3 bytes (compression/filter/interlace) already zero.
  const rowBytes = 1 + width * 3; // leading filter-type byte per PNG spec
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r; raw[px + 1] = g; raw[px + 2] = b;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function fixedMetadata(pdf, title) {
  pdf.setTitle(title);
  pdf.setAuthor("YOYOPDF test fixture");
  pdf.setCreator("YOYOPDF fixture generator");
  pdf.setProducer("pdf-lib 1.17.1");
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);
}

async function makePdf(pageCount, title) {
  const pdf = await PDFDocument.create();
  fixedMetadata(pdf, title);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < pageCount; index += 1) {
    const page = pdf.addPage([420, 594]);
    page.drawText(title + " - page " + (index + 1), {
      x: 36,
      y: 540,
      size: 18,
      font,
      color: rgb(0.1, 0.2, 0.5),
    });
    page.drawRectangle({
      x: 36,
      y: 420 - index * 12,
      width: 180 + index * 24,
      height: 72,
      color: rgb(0.92, 0.5, 0.15),
    });
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function makeFormPdf() {
  const pdf = await PDFDocument.create();
  fixedMetadata(pdf, "YOYOPDF form fixture");
  const page = pdf.addPage([420, 594]);
  const form = pdf.getForm();
  const field = form.createTextField("TestField");
  field.addToPage(page, { x: 36, y: 500, width: 200, height: 24 });
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

async function makeZip(entries) {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) {
    zip.file(name, value, { date: FIXED_DATE, createFolders: false });
  }
  return Buffer.from(await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "DOS",
  }));
}

function officeFixtures() {
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`;

  return {
    "minimal.docx": makeZip({
      "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      "_rels/.rels": rels + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>YOYOPDF DOCX fixture</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
    }),
    "minimal.xlsx": makeZip({
      "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
      "_rels/.rels": rels + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Fixture" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": rels + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>YOYOPDF</t></is></c><c r="B1"><v>11</v></c></row></sheetData></worksheet>`,
    }),
    "minimal.pptx": makeZip({
      "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`,
      "_rels/.rels": rels + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
      "ppt/presentation.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
      "ppt/_rels/presentation.xml.rels": rels + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`,
      "ppt/slides/slide1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld></p:sld>`,
    }),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function buildFixtures() {
  const files = {
    "valid.pdf": await makePdf(1, "YOYOPDF valid fixture"),
    "multipage.pdf": await makePdf(3, "YOYOPDF multipage fixture"),
    // Phase 12: the only fixture actually large enough to exercise
    // large-document behavior - every other PDF fixture here is 1-3
    // pages, nowhere near YOYO_RESOURCE_LIMITS.maxPdfPages (1500). 250
    // pages is comfortably past the "large document" threshold worth
    // measuring (completion time, memory) while staying well under that
    // ceiling and fast enough to regenerate/check in CI.
    "large.pdf": await makePdf(250, "YOYOPDF large fixture"),
    // Phase 12: the only fixture with a real AcroForm field - needed to
    // test Fill PDF Form's actual field-detection/fill path (every other
    // fixture has zero form fields, which only exercises its "no fillable
    // fields" empty-state message, never the real fill+export behavior).
    "form.pdf": await makeFormPdf(),
    "simple.png": PNG_BYTES,
    // Phase 12 (continuation): 200x150 solid orange, real pixel dimensions
    // large enough that a genuine crop-tool drag measurably shrinks the
    // output - simple.png's 2x2 is too small for that (any crop of it
    // already rounds to <=2px either way).
    "sizable.png": makeSolidPng(200, 150, [0xe8, 0x7a, 0x1a]),
    "malformed.pdf": Buffer.from("%PDF-1.7\nThis is deliberately malformed.\n", "utf8"),
    "empty.bin": Buffer.alloc(0),
  };
  const office = officeFixtures();
  for (const [name, promise] of Object.entries(office)) files[name] = await promise;

  const manifest = Object.fromEntries(
    Object.keys(files).sort().map((name) => [
      name,
      { bytes: files[name].length, sha256: sha256(files[name]) },
    ])
  );
  files["manifest.json"] = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return files;
}

const fixtures = await buildFixtures();
mkdirSync(HERE, { recursive: true });

let failed = false;
for (const [name, expected] of Object.entries(fixtures)) {
  const target = join(HERE, name);
  if (CHECK) {
    if (!existsSync(target) || !readFileSync(target).equals(expected)) {
      console.error("Fixture is missing or stale: " + name);
      failed = true;
    }
  } else {
    writeFileSync(target, expected);
  }
}

if (failed) process.exit(1);
console.log((CHECK ? "Verified " : "Generated ") + Object.keys(fixtures).length + " deterministic fixtures.");
