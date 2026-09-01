/* Browser-local PDF sanitization.
   This module deliberately rebuilds the reachable document graph in a fresh
   PDFDocument instead of deleting references in-place. pdf-lib serializes every
   indirect object in a context, including objects that have become unreachable;
   an in-place delete could therefore leave the bytes of an attachment, script,
   form value, or metadata stream recoverable in the downloaded file. */
(function (global) {
  "use strict";

  const DEFAULT_OPTIONS = Object.freeze({
    documentMetadata: true,
    descriptiveMetadata: true,
    actionsAndJavaScript: true,
    attachments: true,
    forms: true,
    annotations: true,
    pagePrivateData: true,
  });

  const N = (name) => global.PDFLib.PDFName.of(name);
  const isName = (value, name) => value && value.toString && value.toString() === `/${name}`;
  const lookupDict = (context, value) => {
    try { return context.lookupMaybe(value, global.PDFLib.PDFDict); }
    catch (_) { return undefined; }
  };
  const lookupArray = (context, value) => {
    try { return context.lookupMaybe(value, global.PDFLib.PDFArray); }
    catch (_) { return undefined; }
  };

  function normalizeOptions(options) {
    return { ...DEFAULT_OPTIONS, ...(options || {}) };
  }

  function safeMetadata(getter) {
    try { return getter() || ""; }
    catch (_) { return ""; }
  }

  function countNamesEntry(doc, key) {
    const names = lookupDict(doc.context, doc.catalog.get(N("Names")));
    return names && names.has(N(key)) ? 1 : 0;
  }

  function inspectAnnotations(doc, report) {
    doc.getPages().forEach((page) => {
      const annots = lookupArray(doc.context, page.node.get(N("Annots")));
      if (!annots) return;
      for (let index = 0; index < annots.size(); index += 1) {
        const annot = lookupDict(doc.context, annots.get(index));
        if (!annot) continue;
        report.annotations += 1;
        const widget = isName(annot.get(N("Subtype")), "Widget");
        const fileAttachment = isName(annot.get(N("Subtype")), "FileAttachment") || annot.has(N("FS"));
        if (widget) report.formWidgets += 1;
        else if (fileAttachment) report.fileAttachmentAnnotations += 1;
        else report.removableAnnotations += 1;
        if (annot.has(N("A")) || annot.has(N("AA")) || annot.has(N("JS"))) report.annotationActions += 1;
      }
    });
  }

  function visitFormFields(doc, visitor) {
    const acroForm = lookupDict(doc.context, doc.catalog.get(N("AcroForm")));
    const fields = acroForm && lookupArray(doc.context, acroForm.get(N("Fields")));
    if (!fields) return;
    const seen = new Set();
    const visit = (value) => {
      const marker = value && value.toString ? value.toString() : "";
      if (marker && seen.has(marker)) return;
      if (marker) seen.add(marker);
      const field = lookupDict(doc.context, value);
      if (!field) return;
      visitor(field);
      const kids = lookupArray(doc.context, field.get(N("Kids")));
      if (kids) for (let index = 0; index < kids.size(); index += 1) visit(kids.get(index));
    };
    for (let index = 0; index < fields.size(); index += 1) visit(fields.get(index));
  }

  async function inspectPdf(input) {
    const { PDFDocument } = global.PDFLib;
    let doc;
    try {
      doc = await PDFDocument.load(input, { updateMetadata: false, throwOnInvalidObject: false });
    } catch (error) {
      const message = /encrypt|password/i.test(String(error && error.message))
        ? "This PDF is encrypted. Unlock it with the authorized password before sanitizing."
        : "This PDF could not be parsed safely and was not sanitized.";
      const wrapped = new Error(message);
      wrapped.code = /encrypt|password/i.test(String(error && error.message)) ? "ENCRYPTED_PDF" : "UNSUPPORTED_PDF";
      wrapped.cause = error;
      throw wrapped;
    }

    const descriptiveValues = [
      safeMetadata(() => doc.getTitle()), safeMetadata(() => doc.getSubject()), safeMetadata(() => doc.getKeywords()),
    ];
    const documentValues = [
      safeMetadata(() => doc.getAuthor()), safeMetadata(() => doc.getCreator()), safeMetadata(() => doc.getProducer()),
      safeMetadata(() => doc.getCreationDate()), safeMetadata(() => doc.getModificationDate()),
    ];
    const sourceInfo = lookupDict(doc.context, doc.context.trailerInfo.Info);
    const knownInfoKeys = new Set(["Title", "Subject", "Keywords", "Author", "Creator", "Producer", "CreationDate", "ModDate"]);
    const customMetadataFields = sourceInfo
      ? sourceInfo.keys().filter((key) => !knownInfoKeys.has(key.toString().slice(1))).length
      : 0;
    const descriptiveMetadataFields = descriptiveValues.filter(Boolean).length;
    const documentMetadataFields = documentValues.filter(Boolean).length + customMetadataFields;
    const report = {
      pageCount: doc.getPageCount(),
      metadataFields: documentMetadataFields + descriptiveMetadataFields,
      documentMetadataFields,
      descriptiveMetadataFields,
      xmpMetadata: doc.catalog.has(N("Metadata")) ? 1 : 0,
      documentActions: (doc.catalog.has(N("OpenAction")) ? 1 : 0) + (doc.catalog.has(N("AA")) ? 1 : 0),
      javascriptNameTrees: countNamesEntry(doc, "JavaScript"),
      attachmentNameTrees: countNamesEntry(doc, "EmbeddedFiles"),
      associatedFiles: doc.catalog.has(N("AF")) ? 1 : 0,
      forms: doc.catalog.has(N("AcroForm")) ? 1 : 0,
      optionalContentLayers: doc.catalog.has(N("OCProperties")) ? 1 : 0,
      annotations: 0,
      removableAnnotations: 0,
      formWidgets: 0,
      fileAttachmentAnnotations: 0,
      annotationActions: 0,
      formActions: 0,
      pagePrivateEntries: 0,
    };
    doc.getPages().forEach((page) => {
      ["Metadata", "PieceInfo", "LastModified", "Thumb"].forEach((key) => {
        if (page.node.has(N(key))) report.pagePrivateEntries += 1;
      });
      if (page.node.has(N("AA"))) report.documentActions += 1;
      if (page.node.has(N("AF"))) report.associatedFiles += 1;
    });
    inspectAnnotations(doc, report);
    visitFormFields(doc, (field) => {
      if (field.has(N("A")) || field.has(N("AA")) || field.has(N("JS"))) report.formActions += 1;
    });
    return { doc, report };
  }

  function copyCatalogEntry(source, output, copier, key) {
    const value = source.catalog.get(N(key));
    if (value) output.catalog.set(N(key), copier.copy(value));
  }

  function copyInfoDictionary(source, output, copier, options) {
    const sourceInfo = source.context.trailerInfo.Info;
    if (!sourceInfo) {
      output.context.trailerInfo.Info = undefined;
      return undefined;
    }
    const sourceDict = lookupDict(source.context, sourceInfo);
    const copiedInfo = output.context.obj({});
    sourceDict.entries().forEach(([key, value]) => {
      const plain = key.toString().slice(1);
      const descriptive = plain === "Title" || plain === "Subject" || plain === "Keywords";
      if (descriptive ? options.descriptiveMetadata : options.documentMetadata) return;
      copiedInfo.set(key, copier.copy(value));
    });
    if (copiedInfo.keys().length === 0) {
      output.context.trailerInfo.Info = undefined;
      return undefined;
    }
    const ref = output.context.register(copiedInfo);
    output.context.trailerInfo.Info = ref;
    return copiedInfo;
  }

  function copyNames(source, output, copier, options) {
    const sourceNames = lookupDict(source.context, source.catalog.get(N("Names")));
    if (!sourceNames) return;
    const destinationNames = output.context.obj({});
    sourceNames.entries().forEach(([key, value]) => {
      const plain = key.toString().slice(1);
      if (plain === "EmbeddedFiles" && options.attachments) return;
      if (plain === "JavaScript" && options.actionsAndJavaScript) return;
      // Preserve navigation/name-tree features which are not selected cleanup
      // categories. The safe preset still strips active and embedded payloads.
      destinationNames.set(key, copier.copy(value));
    });
    if (destinationNames.keys().length > 0) output.catalog.set(N("Names"), destinationNames);
  }

  function rewriteAnnotations(output, options, stats) {
    output.getPages().forEach((page) => {
      const annots = lookupArray(output.context, page.node.get(N("Annots")));
      if (annots) {
        const kept = output.context.obj([]);
        for (let index = 0; index < annots.size(); index += 1) {
          const entry = annots.get(index);
          const annot = lookupDict(output.context, entry);
          if (!annot) continue;
          const widget = isName(annot.get(N("Subtype")), "Widget");
          const fileAttachment = isName(annot.get(N("Subtype")), "FileAttachment") || annot.has(N("FS"));
          if ((options.annotations && !widget && !fileAttachment) || (options.forms && widget) || (options.attachments && fileAttachment)) {
            stats.removedAnnotations += 1;
            continue;
          }
          if (options.actionsAndJavaScript) {
            ["A", "AA", "JS"].forEach((key) => annot.delete(N(key)));
          }
          kept.push(entry);
        }
        if (kept.size() > 0) page.node.set(N("Annots"), kept);
        else page.node.delete(N("Annots"));
      }
      if (options.actionsAndJavaScript) {
        ["AA", "Trans", "Dur", "PresSteps"].forEach((key) => page.node.delete(N(key)));
      }
      if (options.attachments) page.node.delete(N("AF"));
      if (options.pagePrivateData) {
        ["Metadata", "PieceInfo", "LastModified", "Thumb"].forEach((key) => page.node.delete(N(key)));
      }
    });
  }

  function stripFormActions(doc) {
    const acroForm = lookupDict(doc.context, doc.catalog.get(N("AcroForm")));
    if (acroForm) acroForm.delete(N("XFA"));
    visitFormFields(doc, (field) => ["A", "AA", "JS"].forEach((key) => field.delete(N(key))));
  }

  function verifySelectedCategories(report, options) {
    const failures = [];
    if (options.documentMetadata && report.documentMetadataFields) failures.push("document metadata");
    if (options.descriptiveMetadata && report.descriptiveMetadataFields) failures.push("descriptive metadata");
    if ((options.documentMetadata || options.descriptiveMetadata) && report.xmpMetadata) failures.push("XMP metadata");
    if (options.actionsAndJavaScript && (report.documentActions || report.javascriptNameTrees || report.annotationActions || report.formActions)) failures.push("JavaScript/actions");
    if (options.attachments && (report.attachmentNameTrees || report.fileAttachmentAnnotations || report.associatedFiles)) failures.push("attachments");
    if (options.forms && (report.forms || report.formWidgets)) failures.push("forms");
    if (options.annotations && report.removableAnnotations) failures.push("annotations");
    if (options.pagePrivateData && report.pagePrivateEntries) failures.push("page-private data");
    if (failures.length) throw new Error(`Sanitization verification failed for: ${failures.join(", ")}. No download was created.`);
  }

  async function sanitizePdf(input, requestedOptions, onProgress) {
    if (!global.PDFLib) throw new Error("PDF processing library is unavailable.");
    const options = normalizeOptions(requestedOptions);
    const { PDFDocument, PDFObjectCopier, PDFPage } = global.PDFLib;
    const sourceBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const { doc: source, report: before } = await inspectPdf(sourceBytes);
    if (options.pagePrivateData && before.optionalContentLayers) {
      const error = new Error("This PDF contains optional-content layers. They cannot be safely removed without risking visible page changes, so no sanitized file was produced.");
      error.code = "UNSUPPORTED_OPTIONAL_CONTENT";
      throw error;
    }
    // Remove selected page objects in the parsed source graph before copying.
    // Doing this after copying would leave their indirect payloads registered as
    // orphan objects in the destination serializer.
    rewriteAnnotations(source, options, { removedAnnotations: 0 });
    if (options.actionsAndJavaScript && !options.forms) stripFormActions(source);
    const output = await PDFDocument.create();
    if (output.getPageCount()) output.removePage(0);
    const copier = PDFObjectCopier.for(source.context, output.context);
    const sourcePages = source.getPages();
    for (let index = 0; index < sourcePages.length; index += 1) {
      const copiedNode = copier.copy(sourcePages[index].node);
      const copiedRef = output.context.register(copiedNode);
      output.addPage(PDFPage.of(copiedNode, copiedRef, output));
      if (onProgress) onProgress(index + 1, sourcePages.length, "copying");
    }

    // Preserve non-private navigation/accessibility/display structures using
    // the same copier as the pages so shared references remain shared.
    ["ViewerPreferences", "PageLayout", "PageMode", "Lang", "MarkInfo", "Dests"]
      .forEach((key) => copyCatalogEntry(source, output, copier, key));
    if (!options.pagePrivateData && !options.attachments) copyCatalogEntry(source, output, copier, "StructTreeRoot");
    if (!options.actionsAndJavaScript && !options.attachments) copyCatalogEntry(source, output, copier, "Outlines");
    if (!options.pagePrivateData) copyCatalogEntry(source, output, copier, "OCProperties");
    copyNames(source, output, copier, options);

    if (!options.actionsAndJavaScript) {
      ["OpenAction", "AA"].forEach((key) => copyCatalogEntry(source, output, copier, key));
    }
    if (!options.attachments) {
      ["AF", "Collection"].forEach((key) => copyCatalogEntry(source, output, copier, key));
    }
    if (!options.forms) {
      ["AcroForm", "Perms"].forEach((key) => copyCatalogEntry(source, output, copier, key));
    }
    if (!(options.documentMetadata || options.descriptiveMetadata)) {
      copyCatalogEntry(source, output, copier, "Metadata");
    }

    copyInfoDictionary(source, output, copier, options);
    const bytes = await output.save({ useObjectStreams: false, addDefaultPage: false, objectsPerTick: 25 });
    if (onProgress) onProgress(sourcePages.length, sourcePages.length, "verifying");
    const { report: after } = await inspectPdf(bytes.slice(0));
    verifySelectedCategories(after, options);
    return { bytes, before, after, options };
  }

  global.PdfSanitizer = Object.freeze({ DEFAULT_OPTIONS, inspectPdf, sanitizePdf, verifySelectedCategories });
})(window);
