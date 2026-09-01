import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import vm from "node:vm";

const context = vm.createContext({
  console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
  Uint8Array, ArrayBuffer, DataView, Promise, crypto: crypto.webcrypto,
});
context.window = context;
context.self = context;
vm.runInContext(fs.readFileSync("assets/vendor/pdf-lib/1.17.1/pdf-lib.min.js", "utf8"), context);
vm.runInContext(fs.readFileSync("js/core/pdf-crypto.js", "utf8"), context);
vm.runInContext(fs.readFileSync("js/core/pdf-sanitize.js", "utf8"), context);

const { PDFDocument, StandardFonts, PDFName, PDFString, rgb } = context.PDFLib;
const original = await PDFDocument.create();
const page = original.addPage();
page.setSize(420, 300);
const font = await original.embedFont(StandardFonts.Helvetica);
page.drawText("VISIBLE TEXT MUST REMAIN SELECTABLE", { x: 36, y: 230, size: 18, font, color: rgb(0, 0, 0) });
original.setTitle("PRIVATE TITLE");
original.setSubject("PRIVATE SUBJECT");
original.setAuthor("PRIVATE AUTHOR");
original.setCreator("PRIVATE CREATOR");
original.setProducer("PRIVATE PRODUCER");
original.setKeywords(vm.runInContext('["PRIVATE", "KEYWORD"]', context));
await original.attach(new Uint8Array([65, 84, 84, 65, 67, 72, 77, 69, 78, 84, 95, 83, 69, 67, 82, 69, 84]), "private.txt", {
  mimeType: "text/plain",
  description: "PRIVATE ATTACHMENT",
});
original.addJavaScript("private-script", "app.alert('PRIVATE_SCRIPT_MARKER')");
original.catalog.set(PDFName.of("OpenAction"), original.context.obj({
  S: PDFName.of("JavaScript"), JS: PDFString.of("app.alert('PRIVATE_OPEN_ACTION')"),
}));
page.node.set(PDFName.of("Metadata"), original.context.stream(new TextEncoder().encode("PRIVATE_PAGE_METADATA")));
const field = original.getForm().createTextField("private.form.value");
field.setText("PRIVATE FORM VALUE");
field.addToPage(page, { x: 36, y: 150, width: 180, height: 30 });

const sourceBytes = await original.save({ useObjectStreams: false });
const sourceHash = crypto.createHash("sha256").update(sourceBytes).digest("hex");
const before = (await context.PdfSanitizer.inspectPdf(sourceBytes.slice(0))).report;
assert.ok(before.metadataFields >= 6, "fixture metadata should be detected");
assert.equal(before.attachmentNameTrees, 1, "fixture attachment should be detected");
assert.equal(before.javascriptNameTrees, 1, "fixture JavaScript should be detected");
assert.equal(before.forms, 1, "fixture form should be detected");
assert.ok(before.formWidgets >= 1, "fixture widget should be detected");
assert.ok(before.pagePrivateEntries >= 1, "fixture page metadata should be detected");

const result = await context.PdfSanitizer.sanitizePdf(sourceBytes.slice(0));
const after = result.after;
assert.doesNotMatch(Buffer.from(result.bytes).toString("latin1"), /PRIVATE/, "selected private payload markers must not remain in serialized objects");
assert.equal(after.metadataFields, 0);
assert.equal(after.xmpMetadata, 0);
assert.equal(after.documentActions, 0);
assert.equal(after.javascriptNameTrees, 0);
assert.equal(after.attachmentNameTrees, 0);
assert.equal(after.associatedFiles, 0);
assert.equal(after.forms, 0);
assert.equal(after.formWidgets, 0);
assert.equal(after.annotations, 0);
assert.equal(after.pagePrivateEntries, 0);

const reopened = await PDFDocument.load(result.bytes.slice(0), { updateMetadata: false });
assert.equal(reopened.getPageCount(), 1);
assert.equal(reopened.getPage(0).getWidth(), 420);
assert.equal(reopened.getPage(0).getHeight(), 300);
assert.equal(reopened.getForm().getFields().length, 0);
assert.equal(crypto.createHash("sha256").update(sourceBytes).digest("hex"), sourceHash, "source bytes must remain unchanged");
assert.notEqual(crypto.createHash("sha256").update(result.bytes).digest("hex"), sourceHash, "sanitized output must be a new file");

const metadataOnly = await context.PdfSanitizer.sanitizePdf(sourceBytes.slice(0), {
  documentMetadata: true,
  descriptiveMetadata: false,
  actionsAndJavaScript: false,
  attachments: false,
  forms: false,
  annotations: false,
  pagePrivateData: false,
});
assert.equal(metadataOnly.after.documentMetadataFields, 0, "selected identity/provenance metadata should be removed");
assert.equal(metadataOnly.after.descriptiveMetadataFields, 3, "unselected descriptive metadata should remain");
assert.equal(metadataOnly.after.attachmentNameTrees, 1, "unselected attachments should remain");
assert.equal(metadataOnly.after.javascriptNameTrees, 1, "unselected JavaScript should remain");
assert.equal(metadataOnly.after.forms, 1, "unselected forms should remain");
assert.equal(metadataOnly.after.formWidgets, 1, "unselected form widgets should remain connected to pages");

const encryptedBytes = await context.encryptPdfBytes(sourceBytes.slice(0), { userPassword: "authorized-test-password" });
await assert.rejects(
  context.PdfSanitizer.inspectPdf(encryptedBytes.slice(0)),
  (error) => error && error.code === "ENCRYPTED_PDF" && /Unlock it/.test(error.message),
  "encrypted input should fail clearly instead of producing an unsafe output",
);

if (process.env.SANITIZE_FIXTURE_DIR) {
  fs.mkdirSync(process.env.SANITIZE_FIXTURE_DIR, { recursive: true });
  fs.writeFileSync(`${process.env.SANITIZE_FIXTURE_DIR}/sanitize-source.pdf`, sourceBytes);
  fs.writeFileSync(`${process.env.SANITIZE_FIXTURE_DIR}/sanitize-output.pdf`, result.bytes);
}

console.log(JSON.stringify({ sourceBytes: sourceBytes.length, sanitizedBytes: result.bytes.length, before, after }, null, 2));
