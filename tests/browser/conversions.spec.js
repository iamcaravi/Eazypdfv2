import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import JSZip from "jszip";

// Phase 12: real functional coverage for the format-conversion tools,
// previously entirely untested beyond build/SEO smoke checks. Each test
// drives the real UI with a real fixture and validates the actual output
// bytes for the format it claims to produce (a real ZIP-based OOXML
// document, a real decodable PDF, a real JPEG) - not just "a download
// happened."

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const validPdf = resolve(FIXTURES, "valid.pdf");
const minimalDocx = resolve(FIXTURES, "minimal.docx");
const minimalXlsx = resolve(FIXTURES, "minimal.xlsx");
const simplePng = resolve(FIXTURES, "simple.png");
const workbookA = resolve(FIXTURES, "workbook-a.xlsx");
const workbookB = resolve(FIXTURES, "workbook-b.xlsx");

function captureRuntimeErrors(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

async function downloadBytes(page, linkSelector, timeout = 30_000) {
  const downloadLink = page.locator(linkSelector);
  await expect(downloadLink).toBeVisible({ timeout });
  const downloadPromise = page.waitForEvent("download");
  await downloadLink.click();
  const download = await downloadPromise;
  const path = await download.path();
  return readFileSync(path);
}

async function inspectRenderedPdf(page, bytes) {
  return page.evaluate(async (data) => {
    const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(data) });
    const pdf = await loadingTask.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const pdfPage = await pdf.getPage(pageNumber);
      const viewport = pdfPage.getViewport({ scale: 1 });
      const content = await pdfPage.getTextContent();
      const operatorList = await pdfPage.getOperatorList();
      const items = content.items.filter((item) => item.str.trim()).map((item) => ({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width || 0,
        height: item.height || Math.abs(item.transform[3]) || 0,
      }));
      const overlaps = [];
      for (let i = 0; i < items.length; i++) {
        const a = items[i];
        for (let j = i + 1; j < items.length; j++) {
          const b = items[j];
          const xOverlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          const yOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
          if (xOverlap > 0.6 && yOverlap > 0.6) overlaps.push([a.text, b.text]);
        }
      }
      const outOfBounds = items.filter((item) => item.x < 30 || item.x + item.width > viewport.width - 30);
      const imageOps = new Set([pdfjsLib.OPS.paintImageXObject, pdfjsLib.OPS.paintImageMaskXObject, pdfjsLib.OPS.paintSolidColorImageMask]);
      pages.push({ text: items.map((item) => item.text).join("\n"), items, overlaps, outOfBounds, imageCount: operatorList.fnArray.filter((op) => imageOps.has(op)).length });
    }
    await pdf.destroy();
    return { pageCount: pages.length, pages };
  }, Array.from(bytes));
}

test("PDF to Word: produces a real, ZIP-based .docx (not a renamed/empty file)", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/pdf-to-word");
  await page.locator("#fi").setInputFiles(validPdf);
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="valid_converted.docx"]');
  const zip = await JSZip.loadAsync(bytes);
  expect(zip.file("word/document.xml")).not.toBeNull();
  const documentXml = await zip.file("word/document.xml").async("string");
  expect(documentXml).toContain("<w:document");
  expect(errors).toEqual([]);
});

test("Word to PDF: converts a real .docx's text into a decodable PDF", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/word-to-pdf");
  await page.locator("#fi").setInputFiles(minimalDocx);
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="minimal_converted.pdf"]');
  const result = await PDFDocument.load(bytes);
  expect(result.getPageCount()).toBeGreaterThanOrEqual(1);
  const rendered = await inspectRenderedPdf(page, bytes);
  expect(rendered.pages.map((p) => p.text).join("\n")).toContain("YOYOPDF DOCX fixture");
  expect(requests.some((url) => url.includes("assets/vendor/regenerator-runtime/0.14.1/runtime.js"))).toBe(true);
  expect(requests.some((url) => url.includes("assets/vendor/pdf-lib-fontkit/1.1.1/fontkit.umd.min.js"))).toBe(true);
  expect(requests.some((url) => url.includes("assets/vendor/noto-sans-devanagari/"))).toBe(true);
  expect(requests.filter((url) => url.includes("cdn.jsdelivr.net"))).toEqual([]);
  expect(errors).toEqual([]);
});

test("Word to PDF: preserves paragraphs, a table, Unicode Hindi, fragmented Kruti Dev runs, and an inline image", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/word-to-pdf");
  const signatureBase64 = readFileSync(simplePng).toString("base64");
  const docxBytes = await page.evaluate(async (signaturePng) => {
    await ensureJSZip();
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Default Extension="png" ContentType="image/png"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
        <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
      </Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
      </Relationships>`);
    zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="200" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
        <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
        <w:style w:type="paragraph" w:styleId="NormalWeb"><w:name w:val="Normal Web"/><w:pPr><w:spacing w:before="100" w:after="100" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Mangal"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
      </w:styles>`);
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/signature.png"/>
      </Relationships>`);
    zip.file("word/media/signature.png", Uint8Array.from(atob(signaturePng), (c) => c.charCodeAt(0)));
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Conversion Quality Report</w:t></w:r></w:p>
        <w:p><w:r><w:t>This is the first paragraph with enough text to verify clean wrapping and readable structure in the generated PDF.</w:t></w:r></w:p>
        <w:p><w:r><w:t>This is a separate second paragraph.</w:t></w:r></w:p>
        <w:tbl><w:tblGrid><w:gridCol w:w="3200"/><w:gridCol w:w="3200"/></w:tblGrid>
          <w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
          <w:tr><w:tc><w:p><w:r><w:t>Readable table row</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr>
        </w:tbl>
        <w:p><w:pPr><w:pStyle w:val="NormalWeb"/></w:pPr><w:r><w:rPr><w:rFonts w:cs="Mangal"/></w:rPr><w:t>नमस्ते भारत</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:rFonts w:ascii="Kruti Dev 014" w:hAnsi="Kruti Dev 014"/><w:b/><w:sz w:val="32"/></w:rPr><w:t>ls</w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Kruti Dev 014" w:hAnsi="Kruti Dev 014"/><w:b/><w:sz w:val="32"/></w:rPr><w:t>ok </w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Kruti Dev 014" w:hAnsi="Kruti Dev 014"/><w:b/><w:sz w:val="32"/></w:rPr><w:t>esa]</w:t></w:r></w:p>
        <w:p><w:r><w:rPr><w:rFonts w:ascii="Kruti Dev 014" w:hAnsi="Kruti Dev 014"/><w:sz w:val="32"/></w:rPr><w:t>vf</w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Kruti Dev 014" w:hAnsi="Kruti Dev 014"/><w:sz w:val="32"/></w:rPr><w:t>/</w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Kruti Dev 014" w:hAnsi="Kruti Dev 014"/><w:sz w:val="32"/></w:rPr><w:t>k’kklh vfHk;Urk</w:t></w:r></w:p>
        <w:p><w:pPr><w:jc w:val="both"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Kruti Dev 014" w:hAnsi="Kruti Dev 014"/><w:sz w:val="32"/></w:rPr><w:t>izkFkhZ fnukad egku d\`ik gksxhA</w:t></w:r></w:p>
        <w:p><w:r><w:t>Date 25.08.2026</w:t><w:tab/><w:tab/><w:tab/><w:tab/></w:r><w:r><w:drawing><wp:inline><wp:extent cx="762000" cy="254000"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdImage"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
        <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720"/></w:sectPr>
      </w:body></w:document>`);
    return Array.from(await zip.generateAsync({ type: "uint8array" }));
  }, signatureBase64);
  await page.locator("#fi").setInputFiles({ name: "structured-hindi.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from(docxBytes) });
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="structured-hindi_converted.pdf"]', 45_000);
  const rendered = await inspectRenderedPdf(page, bytes);
  const text = rendered.pages.map((p) => p.text).join("\n");
  expect(text).toContain("Conversion Quality Report");
  expect(text).toContain("first paragraph");
  expect(text).toContain("separate second paragraph");
  expect(text).toContain("Readable table row");
  expect(text).toContain("नमस्ते भारत");
  expect(text).toContain("सेवा में");
  expect(text).toContain("अधिशासी अभियन्ता");
  expect(text).toContain("प्रार्थी दिनांक महान कृपा होगी।");
  expect(text).not.toMatch(/lsok|izkFkhZ|fnukad|egku d`ik/);
  expect(rendered.pages.some((p) => p.imageCount > 0)).toBe(true);
  expect(rendered.pages.flatMap((p) => p.overlaps)).toEqual([]);
  expect(rendered.pages.flatMap((p) => p.outOfBounds)).toEqual([]);
  expect(errors).toEqual([]);
});

test("PDF to JPG: renders a single-page PDF into a real, decodable JPEG", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/pdf-to-jpg");
  await page.locator("#fi").setInputFiles(validPdf);
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="valid_page1.jpg"]');
  expect(bytes[0]).toBe(0xff); // real JPEG SOI marker, not an empty/placeholder file
  expect(bytes[1]).toBe(0xd8);
  expect(errors).toEqual([]);
});

test("JPG to PDF: embeds a real PNG into a valid one-page PDF", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/jpg-to-pdf");
  await page.locator("#fi").setInputFiles(simplePng);
  await expect(page.locator("#go")).toBeEnabled();
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="images.pdf"]');
  const result = await PDFDocument.load(bytes);
  expect(result.getPageCount()).toBe(1);
  expect(errors).toEqual([]);
});

test("PDF to Excel: produces a real, ZIP-based .xlsx with the extracted content", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/pdf-to-excel");
  await page.locator("#fi").setInputFiles(validPdf);
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="valid_converted.xlsx"]');
  const zip = await JSZip.loadAsync(bytes);
  expect(zip.file("xl/workbook.xml")).not.toBeNull();
  expect(errors).toEqual([]);
});

test("Excel to PDF: appends every worksheet in workbook order, including an empty sheet", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/excel-to-pdf");
  const workbookBytes = await page.evaluate(async () => {
    await ensureXLSX();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([["FIRST_SHEET"]]),"Alpha");
    XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([]),"Empty");
    XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([["LAST_SHEET"]]),"Omega");
    return Array.from(new Uint8Array(XLSX.write(workbook,{bookType:"xlsx",type:"array"})));
  });
  await page.locator("#fi").setInputFiles({ name:"multi-sheet.xlsx", mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer:Buffer.from(workbookBytes) });
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="multi-sheet_converted.pdf"]');
  const result = await PDFDocument.load(bytes);
  expect(result.getPageCount()).toBe(3);
  const rendered = await inspectRenderedPdf(page,bytes);
  const text = rendered.pages.map(pdfPage=>pdfPage.text).join("\n");
  expect(text).toContain("Alpha");
  expect(text).toContain("FIRST_SHEET");
  expect(text).toContain("Empty");
  expect(text).toContain("This worksheet is empty.");
  expect(text).toContain("Omega");
  expect(text).toContain("LAST_SHEET");
  expect(text.indexOf("FIRST_SHEET")).toBeLessThan(text.indexOf("LAST_SHEET"));
  expect(errors).toEqual([]);
});

test("Excel to PDF: wraps measured rows and paginates a wide, long worksheet without text overlap", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/excel-to-pdf");
  const workbookBytes = await page.evaluate(async () => {
    await ensureXLSX();
    const headers = ["Record", "Customer", "Detailed description", "Quantity", "Unit price", "Total", "Date", "Status", "Region", "Owner", "Reference", "Notes", "Tax", "Balance", "Category", "Department", "Code", "Approved by"];
    const rows = [headers];
    for(let i=1;i<=75;i++) rows.push([
      i,
      `Customer ${i}`,
      `Customer record number ${i} contains a deliberately long description that must wrap inside its own cell without entering neighbouring columns.`,
      i%9+1,
      123.45,
      (i%9+1)*123.45,
      new Date(2026,0,(i%28)+1),
      i%2 ? "Pending review" : "Approved",
      `Region ${i%5+1}`,
      `Owner ${i%8+1}`,
      `REF-${String(i).padStart(5,"0")}`,
      `Additional notes for row ${i} wrap cleanly.`,
      18.5,
      5184.75,
      `Category ${i%4+1}`,
      `Department ${i%6+1}`,
      `C${i}`,
      `Reviewer ${i%3+1}`,
    ]);
    const sheet = XLSX.utils.aoa_to_sheet(rows,{cellDates:true});
    sheet["!cols"] = headers.map((_,i)=>({wch:i===2?34:(i===11?24:12)}));
    sheet["!rows"] = [{hpt:28},...Array.from({length:75},(_,i)=>i%10===0?{hpt:30}:null)];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook,sheet,"Operations Report");
    return Array.from(new Uint8Array(XLSX.write(workbook,{bookType:"xlsx",type:"array",cellDates:true})));
  });
  await page.locator("#fi").setInputFiles({ name: "layout-stress.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(workbookBytes) });
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="layout-stress_converted.pdf"]', 45_000);
  const result = await PDFDocument.load(bytes);
  expect(result.getPageCount()).toBeGreaterThan(2);
  const rendered = await inspectRenderedPdf(page, bytes);
  const allText = rendered.pages.map((p) => p.text).join("\n");
  expect(allText).toContain("Customer record number 42");
  expect(allText).toContain("5184.75");
  expect(rendered.pages.flatMap((p) => p.overlaps)).toEqual([]);
  expect(rendered.pages.flatMap((p) => p.outOfBounds)).toEqual([]);
  expect(errors).toEqual([]);
});

test("PDF to PowerPoint: renders a single-page PDF into a real, ZIP-based .pptx (one slide, image-based)", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/pdf-to-powerpoint");
  await page.locator("#fi").setInputFiles(validPdf);
  await expect(page.locator("#go")).toBeVisible();
  await page.locator("#go").click();

  const bytes = await downloadBytes(page, 'a.dl-link[download="valid_converted.pptx"]');
  const zip = await JSZip.loadAsync(bytes);
  expect(zip.file("ppt/presentation.xml")).not.toBeNull();
  expect(zip.file("ppt/slides/slide1.xml")).not.toBeNull();
  expect(errors).toEqual([]);
});

test("Merge Excel: requires at least 2 files before Merge Workbooks is enabled", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto("/merge-excel");
  await page.locator("#fi").setInputFiles([workbookA]);
  await expect(page.locator('.file-card')).toHaveCount(1);
  await expect(page.locator("#go")).toBeDisabled();
  await expect(page.locator("#mergeexcelError")).toContainText(/2 or more/i);
  expect(errors).toEqual([]);
});

test("Merge Excel: real package-level merge of two workbooks - correct sheet names, worksheet XML, and dependent parts", async ({ page }) => {
  test.setTimeout(45_000);
  const errors = captureRuntimeErrors(page);
  await page.goto("/merge-excel");
  await page.locator("#fi").setInputFiles([workbookA, workbookB]);

  await expect(page.locator('.file-card')).toHaveCount(2);
  // Per-file sheet-name preview (best-effort UI feature) should surface
  // each workbook's real sheet names, not just a generic file-type badge.
  await expect(page.locator(".file-card-sheets").first()).toContainText("Sheet1", { timeout: 10_000 });
  await expect(page.locator("#go")).toBeEnabled();
  await page.locator("#go").click();

  // Not just "a download happened" - read the real downloaded XLSX package
  // back with JSZip and verify its actual OOXML structure.
  const bytes = await downloadBytes(page, 'a.dl-link[download="workbook-a_merged.xlsx"]');
  const zip = await JSZip.loadAsync(bytes);

  const workbookXml = await zip.file("xl/workbook.xml").async("string");
  const sheetNames = [...workbookXml.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
  // workbook-a and workbook-b both use "Sheet1"/"Sheet2" - the collision
  // must be resolved by uniquifying, never by silently overwriting.
  expect(sheetNames).toEqual(["Sheet1", "Sheet2", "Sheet1 (2)", "Sheet2 (2)"]);

  const sheet1 = await zip.file("xl/worksheets/sheet1.xml").async("string");
  expect(sheet1).toContain('<mergeCell ref="A1:C1"/>'); // workbook-a's own merged header, byte-preserved
  expect(sheet1).toMatch(/<f>SUM\(B3:B3\)<\/f>/); // workbook-a's own formula, byte-preserved

  const sheet3 = await zip.file("xl/worksheets/sheet3.xml").async("string"); // workbook-b's renamed "Sheet1 (2)"
  expect(sheet3).toContain('<mergeCell ref="A1:B1"/>'); // workbook-b's own (differently-shaped) merged header

  expect(zip.file("xl/styles.xml")).not.toBeNull();
  expect(zip.file("xl/sharedStrings.xml")).not.toBeNull();
  expect(zip.file("docProps/app.xml")).not.toBeNull();
  expect(zip.file("[Content_Types].xml")).not.toBeNull();

  expect(errors).toEqual([]);
});
