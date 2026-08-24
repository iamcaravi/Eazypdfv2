import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import JSZip from "jszip";

// js/core/xlsx-merge.js is a classic (non-module) browser script - same
// vm-sandbox pattern as tests/pdf-processing-utils.test.js, so this file's
// unmodified source (including its low-level OOXML string/regex logic) is
// exercised exactly as shipped, with JSZip injected the same way it's a
// global <script> in the browser.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = resolve(ROOT, "tests/fixtures");

let XlsxMerge;

beforeAll(() => {
  const source = readFileSync(resolve(ROOT, "js/core/xlsx-merge.js"), "utf8");
  const sandbox = vm.createContext({ JSZip, console });
  vm.runInContext(source, sandbox, { filename: "xlsx-merge.js" });
  XlsxMerge = sandbox.XlsxMerge;
});

function fixtureFile(name) {
  return { name, bytes: readFileSync(resolve(FIXTURES, name)) };
}

async function mergeFixtures(names) {
  const result = await XlsxMerge.mergeWorkbooks(names.map(fixtureFile));
  const zip = await JSZip.loadAsync(result.bytes);
  return { ...result, zip };
}

function textOf(zip, path) {
  const f = zip.file(path);
  return f ? f.async("string") : Promise.resolve(null);
}

describe("XlsxMerge.mergeWorkbooks: package structure", () => {
  it("rejects fewer than 2 files", async () => {
    await expect(XlsxMerge.mergeWorkbooks([fixtureFile("workbook-a.xlsx")])).rejects.toThrow(/at least 2/i);
  });

  it("produces a package that opens without missing required parts", async () => {
    const { zip } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx"]);
    for (const part of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "docProps/app.xml", "docProps/core.xml"]) {
      expect(zip.file(part), part + " must exist").toBeTruthy();
    }
  });

  it("[Content_Types].xml declares every worksheet and dependent part actually present", async () => {
    const { zip } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx", "workbook-image.xlsx"]);
    const ct = await textOf(zip, "[Content_Types].xml");
    const worksheetPaths = Object.keys(zip.files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p));
    expect(worksheetPaths.length).toBe(5);
    for (const p of worksheetPaths) {
      expect(ct).toContain('PartName="/' + p + '"');
    }
    expect(ct).toContain('PartName="/xl/drawings/drawing1.xml"');
    expect(ct).toContain('Extension="png"');
  });

  it("compresses output parts with real DEFLATE, not an accidental STORE-only (uncompressed) package", async () => {
    const { zip } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx"]);
    const xmlParts = Object.keys(zip.files).filter((p) => !zip.files[p].dir && p.endsWith(".xml"));
    expect(xmlParts.length).toBeGreaterThan(0);
    for (const p of xmlParts) {
      const data = zip.files[p]._data;
      // STORE would make compressedSize === uncompressedSize; real DEFLATE
      // on repetitive XML markup should meaningfully shrink it.
      expect(data.compressedSize, p + " was not DEFLATE-compressed").toBeLessThan(data.uncompressedSize);
    }
  });
});

describe("XlsxMerge.mergeWorkbooks: sheet identity", () => {
  it("keeps the first file's sheet names unchanged and uniquifies later collisions", async () => {
    const { sheetNames } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx"]);
    expect(sheetNames).toEqual(["Sheet1", "Sheet2", "Sheet1 (2)", "Sheet2 (2)"]);
  });

  it("keeps incrementing safely across 3+ colliding files", async () => {
    const { sheetNames } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx", "workbook-image.xlsx"]);
    // workbook-image.xlsx's single sheet is also named "Sheet1"
    expect(sheetNames).toEqual(["Sheet1", "Sheet2", "Sheet1 (2)", "Sheet2 (2)", "Sheet1 (3)"]);
  });

  it("workbook.xml's <sheets> lists the same names, in the same order, with correct r:id targets", async () => {
    const { zip, sheetNames } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx"]);
    const workbookXml = await textOf(zip, "xl/workbook.xml");
    const relsXml = await textOf(zip, "xl/_rels/workbook.xml.rels");
    const sheetEls = [...workbookXml.matchAll(/<sheet name="([^"]*)"[^>]*r:id="(rId\d+)"/g)];
    expect(sheetEls.map((m) => m[1])).toEqual(sheetNames);
    sheetEls.forEach((m, i) => {
      const relMatch = new RegExp('Id="' + m[2] + '"[^>]*Target="worksheets/sheet' + (i + 1) + '\\.xml"').exec(relsXml);
      expect(relMatch, "rId " + m[2] + " must target sheet" + (i + 1) + ".xml").toBeTruthy();
    });
  });

  it("docProps/app.xml's TitlesOfParts matches the merged sheet list exactly", async () => {
    const { zip, sheetNames } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx"]);
    const app = await textOf(zip, "docProps/app.xml");
    const titlesBlock = /<TitlesOfParts>([\s\S]*?)<\/TitlesOfParts>/.exec(app)[1];
    const titles = [...titlesBlock.matchAll(/<vt:lpstr>([^<]*)<\/vt:lpstr>/g)].map((m) => m[1]);
    expect(titles).toEqual(sheetNames);
  });
});

describe("XlsxMerge.mergeWorkbooks: cell values, formulas, structure", () => {
  it("preserves dimension, merged cells, freeze panes, row heights and column widths verbatim", async () => {
    const { zip } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx"]);
    const sheet1 = await textOf(zip, "xl/worksheets/sheet1.xml");
    expect(sheet1).toContain('<dimension ref="A1:C4"/>');
    expect(sheet1).toContain('<mergeCell ref="A1:C1"/>');
    expect(sheet1).toContain('ySplit="2"');
    expect(sheet1).toContain('state="frozen"');
    expect(sheet1).toContain('ht="22"');
    expect(sheet1).toContain('width="25"');

    const sheet3 = await textOf(zip, "xl/worksheets/sheet3.xml"); // workbook-b's renamed Sheet1
    expect(sheet3).toContain('<mergeCell ref="A1:B1"/>');
    expect(sheet3).toContain('ht="25"');
    expect(sheet3).toContain('width="30"');
  });

  it("preserves formulas and their cached values", async () => {
    const { zip } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx"]);
    const sheet1 = await textOf(zip, "xl/worksheets/sheet1.xml");
    expect(sheet1).toMatch(/<f>SUM\(B3:B3\)<\/f><v>10<\/v>/);
  });

  it("best-effort rewrites a cross-sheet formula reference that pointed at a since-renamed sheet", async () => {
    const { zip } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx"]);
    // workbook-a's Sheet2 references its own (unrenamed) Sheet1 - must stay literal "Sheet1!".
    const sheet2 = await textOf(zip, "xl/worksheets/sheet2.xml");
    expect(sheet2).toContain("<f>Sheet1!B3</f>");
    // workbook-b's Sheet2 references its own Sheet1, which collided and
    // became "Sheet1 (2)" - the formula text must follow it there.
    const sheet4 = await textOf(zip, "xl/worksheets/sheet4.xml");
    expect(sheet4).toContain("<f>'Sheet1 (2)'!B3</f>");
  });

  it("remaps shared-string indexes correctly per source workbook (no collisions, no off-by-one)", async () => {
    const { zip } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx"]);
    const sst = await textOf(zip, "xl/sharedStrings.xml");
    const strings = [...sst.matchAll(/<si><t>([^<]*)<\/t><\/si>/g)].map((m) => m[1]);
    expect(strings).toEqual([
      "Quarterly Report", "Item", "Qty", "Price", "Widget", "Total", "Notes", "Value", "Reference",
      "Survey Results", "Question", "Score", "Q1", "Total", "Ref"
    ]);

    const sheet1 = await textOf(zip, "xl/worksheets/sheet1.xml");
    expect(sheet1).toMatch(/<c r="A1" t="s" s="1"><v>0<\/v><\/c>/); // "Quarterly Report" at its original index 0

    const sheet3 = await textOf(zip, "xl/worksheets/sheet3.xml"); // workbook-b's Sheet1, offset by 9
    expect(sheet3).toMatch(/<c r="A1" t="s" s="\d+"><v>9<\/v><\/c>/); // "Survey Results" -> 0+9
  });
});

describe("XlsxMerge.mergeWorkbooks: style remap correctness", () => {
  it("resolves a source cell's style index to a merged cellXf pointing at THAT source's own font/fill/border/numFmt, not the other file's", async () => {
    const { zip } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx"]);
    const styles = await textOf(zip, "xl/styles.xml");

    function parseXfs(tag) {
      const block = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">").exec(styles)[1];
      return [...block.matchAll(/<xf\b([^>]*?)\/?>/g)].map((m) => m[1]);
    }
    function attr(str, name) {
      const m = new RegExp(name + '="([^"]*)"').exec(str);
      return m ? m[1] : null;
    }
    const cellXfs = parseXfs("cellXfs");
    const numFmts = [...styles.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"\/>/g)]
      .reduce((m, x) => m.set(x[1], x[2]), new Map());

    // workbook-a's C3 uses s="2" (currency numFmt, defined pre-merge as id 164 -> "#,##0.00").
    const sheet1 = await textOf(zip, "xl/worksheets/sheet1.xml");
    const aStyleIdx = attr(/<c r="C3"([^>]*)>/.exec(sheet1)[1], "s");
    expect(numFmts.get(attr(cellXfs[Number(aStyleIdx)], "numFmtId"))).toBe("#,##0.00");

    // workbook-b's (renamed) Sheet1 B3 uses a DIFFERENT style index post-merge
    // (percent numFmt, originally id 165 -> "0.0%") - must resolve to its
    // OWN format, not workbook-a's currency format at the same raw index.
    const sheet3 = await textOf(zip, "xl/worksheets/sheet3.xml");
    const bStyleIdx = attr(/<c r="B3"([^>]*)>/.exec(sheet3)[1], "s");
    expect(bStyleIdx).not.toBe(aStyleIdx);
    expect(numFmts.get(attr(cellXfs[Number(bStyleIdx)], "numFmtId"))).toBe("0.0%");
  });

  it("merges fonts/fills/borders/cellStyleXfs with correct combined counts (both sources' styles fully present)", async () => {
    const { zip } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx"]);
    const styles = await textOf(zip, "xl/styles.xml");
    expect(styles).toMatch(/<fonts count="4">/);
    expect(styles).toMatch(/<fills count="4">/);
    expect(styles).toMatch(/<borders count="4">/);
    expect(styles).toMatch(/<cellXfs count="6">/);
    expect(styles).toContain('name val="Arial"'); // workbook-a's header font
    expect(styles).toContain('name val="Georgia"'); // workbook-b's header font
  });

  it("keeps exactly one 'Normal' cellStyle (no duplicate-Normal corruption from concatenating both sources')", async () => {
    const { zip } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx"]);
    const styles = await textOf(zip, "xl/styles.xml");
    const normals = [...styles.matchAll(/<cellStyle name="Normal"/g)];
    expect(normals.length).toBe(1);
  });
});

describe("XlsxMerge.mergeWorkbooks: drawings/images", () => {
  it("copies the embedded image and drawing, and rewrites the worksheet's own drawing relationship target", async () => {
    const { zip } = await mergeFixtures(["workbook-a.xlsx", "workbook-image.xlsx"]);
    expect(zip.file("xl/media/image1.png")).toBeTruthy();
    expect(zip.file("xl/drawings/drawing1.xml")).toBeTruthy();
    const drawingRels = await textOf(zip, "xl/drawings/_rels/drawing1.xml.rels");
    expect(drawingRels).toContain('Target="../media/image1.png"');

    const imageSheetPath = "xl/worksheets/sheet3.xml"; // workbook-a's 2 sheets + this workbook's 1
    const sheetXml = await textOf(zip, imageSheetPath);
    expect(sheetXml).toContain("<drawing r:id=");
    const sheetRels = await textOf(zip, "xl/worksheets/_rels/sheet3.xml.rels");
    expect(sheetRels).toContain('Target="../drawings/drawing1.xml"');
  });

  it("the copied image bytes are byte-identical to the source (lossless copy)", async () => {
    const { zip } = await mergeFixtures(["workbook-a.xlsx", "workbook-image.xlsx"]);
    const merged = await zip.file("xl/media/image1.png").async("uint8array");
    const sourceZip = await JSZip.loadAsync(readFileSync(resolve(FIXTURES, "workbook-image.xlsx")));
    const original = await sourceZip.file("xl/media/image1.png").async("uint8array");
    expect(Buffer.from(merged).equals(Buffer.from(original))).toBe(true);
  });
});

describe("XlsxMerge.mergeWorkbooks: warnings are truthful, never silent", () => {
  it("warns about dropped named cell styles instead of silently duplicating/discarding them", async () => {
    const { warnings } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx"]);
    expect(warnings.some((w) => /named cell styles/i.test(w) && /workbook-b\.xlsx/.test(w))).toBe(true);
  });

  it("reports no warnings for a merge with nothing lossy to report beyond named styles", async () => {
    const { warnings } = await mergeFixtures(["workbook-a.xlsx", "workbook-b.xlsx"]);
    // Only the expected named-cell-styles caveat - no theme mismatch, no
    // external links, no unsupported parts in these two fixtures.
    expect(warnings.length).toBe(1);
  });
});

// Regression coverage for a real user report: Microsoft Excel showed its
// "repair" dialog on a merged real-world "Posting Ledger" workbook -
// "Removed Records: Formula from /xl/worksheets/sheet10.xml" and
// "Repaired Records: Format from /xl/styles.xml". workbook-financial-a/b
// reproduce the two confirmed root causes: (1) a shared-formula group
// mixed with an ordinary formula on the same sheet, on a workbook whose
// sheet name collides and gets renamed; (2) a currency numFmt whose
// formatCode needs an XML-escaped literal quote (e.g. an Indian-Rupee
// accounting format), which a naive read-then-re-escape used to
// double-escape into a corrupted format string.
describe("XlsxMerge.mergeWorkbooks: real-world repair-dialog regression (financial ledger shape)", () => {
  it("produces a structurally clean package - the exact class of defect that used to trigger Excel's repair dialog", async () => {
    const { zip } = await mergeFixtures(["workbook-financial-a.xlsx", "workbook-financial-b.xlsx"]);
    const errors = await XlsxMerge.validateMergedPackage(zip);
    expect(errors, "merged package failed structural validation: " + JSON.stringify(errors, null, 2)).toEqual([]);
  });

  it("does not double-escape a numFmt formatCode that itself needs an escaped literal quote (e.g. a Rupee/currency accounting format)", async () => {
    const { zip } = await mergeFixtures(["workbook-financial-a.xlsx", "workbook-financial-b.xlsx"]);
    const stylesXml = await textOf(zip, "xl/styles.xml");
    const formatCodes = [...stylesXml.matchAll(/<numFmt numFmtId="\d+" formatCode="([^"]*)"\/>/g)].map((m) => m[1]);
    expect(formatCodes.length).toBeGreaterThan(0);
    for (const raw of formatCodes) {
      // A single, correct escape of the literal quote characters (&quot;)
      // is expected and fine; a DOUBLE escape (&amp;quot;) is the bug -
      // Excel would decode that back into a literal "&quot;" string
      // inside the number format instead of a real quote character.
      expect(raw, "formatCode is double-escaped: " + raw).not.toContain("&amp;");
      const decoded = raw.replace(/&quot;/g, '"').replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)));
      expect(decoded).toBe('"₹"#,##0.00');
    }
    // Both source files' identical-formatCode custom numFmts must dedupe
    // to ONE merged entry, not two, since numFmtByCode dedupes by the
    // (correctly decoded) format string.
    expect(formatCodes.length).toBe(1);
  });

  it("merges the two source workbooks' identical custom numFmtIds (164 vs 165) into one correctly-remapped shared entry", async () => {
    const { zip } = await mergeFixtures(["workbook-financial-a.xlsx", "workbook-financial-b.xlsx"]);
    const stylesXml = await textOf(zip, "xl/styles.xml");
    const cellXfsBlock = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)[1];
    const xfs = [...cellXfsBlock.matchAll(/<xf\b([^>]*?)\/?>/g)].map((m) => m[1]);
    const numFmtIds = new Set(xfs.map((a) => /numFmtId="(\d+)"/.exec(a)[1]).filter((id) => Number(id) >= 164));
    // Both files' currency-formatted cellXfs entries must end up pointing
    // at the SAME merged numFmtId (the dedup working correctly), not two
    // different ones.
    expect(numFmtIds.size).toBe(1);
  });

  it("preserves a shared-formula group's master cell and follower cells intact after a sheet-name-collision rename", async () => {
    const { zip, sheetNames } = await mergeFixtures(["workbook-financial-a.xlsx", "workbook-financial-b.xlsx"]);
    expect(sheetNames).toEqual(["Ledger", "Summary", "Ledger (2)", "Summary (2)"]);
    for (const path of ["xl/worksheets/sheet1.xml", "xl/worksheets/sheet3.xml"]) {
      const sheetXml = await textOf(zip, path);
      // The master formula keeps its real text + ref + shared-group index.
      expect(sheetXml).toMatch(/<f t="shared" ref="B2:B4" si="0">1400000\+A2<\/f>/);
      // Both follower cells remain genuinely self-closing with no
      // swallowed/embedded markup as "formula text".
      expect(sheetXml).toMatch(/<c r="B3"[^>]*><f t="shared" si="0"\/><v>1446124<\/v><\/c>/);
      expect(sheetXml).toMatch(/<c r="B4"[^>]*><f t="shared" si="0"\/><v>1492372<\/v><\/c>/);
      // The unrelated standalone formula on the same sheet (D2) is untouched.
      expect(sheetXml).toContain("<f>SUM(B2:B2)</f>");
    }
  });

  it("best-effort rewrites the renamed workbook's own cross-sheet formula reference (Summary -> Ledger) without corrupting the shared-formula group on the same sheet", async () => {
    const { zip } = await mergeFixtures(["workbook-financial-a.xlsx", "workbook-financial-b.xlsx"]);
    // sheet4.xml = workbook-financial-b's "Summary" (renamed to "Summary (2)"),
    // whose own formula referenced its sibling "Ledger" - which ALSO
    // collided and got renamed to "Ledger (2)".
    const sheet4 = await textOf(zip, "xl/worksheets/sheet4.xml");
    expect(sheet4).toContain("<f>'Ledger (2)'!B2</f>");
    // And workbook-financial-a's own (unrenamed) Summary sheet must keep
    // its original, un-rewritten reference.
    const sheet2 = await textOf(zip, "xl/worksheets/sheet2.xml");
    expect(sheet2).toContain("<f>Ledger!B2</f>");
  });

  it("keeps merged cells, freeze panes, column widths, and row-level style intact on the shared-formula sheet", async () => {
    const { zip } = await mergeFixtures(["workbook-financial-a.xlsx", "workbook-financial-b.xlsx"]);
    const sheet1 = await textOf(zip, "xl/worksheets/sheet1.xml");
    expect(sheet1).toContain('<mergeCell ref="A1:B1"/>');
    expect(sheet1).toContain('ySplit="1"');
    expect(sheet1).toContain('state="frozen"');
    expect(sheet1).toContain('width="20"');
  });
});
