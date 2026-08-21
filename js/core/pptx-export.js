/* ---------------- Minimal .pptx (OOXML presentation) builder ----------------
   PDF to PowerPoint's only reliable client-side approach: pdf.js rasterizes
   each page (same technique as pdf2jpg), and this module packages those
   page images as a real, valid Office Open XML presentation - one full-
   bleed picture per slide - via JSZip, the same zip library Split/PDF-to-
   Word already lazy-load for their own downloads. This is an HONEST,
   commonly-used approach for a browser-only PDF->PPTX converter (no text/
   shape re-authoring is attempted - text stays exactly as sharp as the
   source page, but it's a picture, not editable text or an editable
   shape), and it sidesteps having to reverse-engineer PDF content streams
   into DrawingML, which no reliable client-side library does.
   Structurally, this hand-writes the smallest set of OOXML parts a real
   presentation needs (content types, package rels, one slide master/layout/
   theme shared by every slide, one slide+rels+image per page) rather than
   pulling in a whole presentation-authoring dependency for "one picture per
   slide". Every part below is boilerplate that's otherwise identical across
   every real .pptx - see each function for what it represents. */

function pptxEsc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function pptxContentTypesXml(slideOverridesXml){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${slideOverridesXml}
</Types>`;
}
function pptxPackageRelsXml(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}
function pptxCoreXml(title){
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${pptxEsc(title)}</dc:title>
<dc:creator>YOYOPDF</dc:creator>
<cp:lastModifiedBy>YOYOPDF</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}
function pptxAppXml(slideCount){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>YOYOPDF</Application>
<Slides>${slideCount}</Slides>
<TitlesOfParts><vt:vector size="0" baseType="lpstr"/></TitlesOfParts>
</Properties>`;
}
function pptxPresentationXml(slideW, slideH, sldIdEntriesXml){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster1"/></p:sldMasterIdLst>
<p:sldIdLst>${sldIdEntriesXml}</p:sldIdLst>
<p:sldSz cx="${slideW}" cy="${slideH}"/>
<p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`;
}
function pptxPresentationRelsXml(slideRelEntriesXml){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
${slideRelEntriesXml}
</Relationships>`;
}
function pptxSlideMasterXml(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree>
</p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout1"/></p:sldLayoutIdLst>
</p:sldMaster>`;
}
function pptxSlideMasterRelsXml(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdLayout1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rIdTheme1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`;
}
function pptxSlideLayoutXml(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">
<p:cSld name="Blank">
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`;
}
function pptxSlideLayoutRelsXml(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`;
}
/** Standard 12-color/2-font/3-style "Office Theme" shape - nothing in our
 * own slide content references it (every slide is one absolute-positioned
 * picture, no placeholders/theme-colored shapes), so it only needs to be
 * structurally complete, not visually tuned. */
function pptxThemeXml(){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="YOYOPDF Theme">
<a:themeElements>
<a:clrScheme name="YOYOPDF">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1F497D"/></a:dk2>
<a:lt2><a:srgbClr val="EEECE1"/></a:lt2>
<a:accent1><a:srgbClr val="4F81BD"/></a:accent1>
<a:accent2><a:srgbClr val="C0504D"/></a:accent2>
<a:accent3><a:srgbClr val="9BBB59"/></a:accent3>
<a:accent4><a:srgbClr val="8064A2"/></a:accent4>
<a:accent5><a:srgbClr val="4BACC6"/></a:accent5>
<a:accent6><a:srgbClr val="F79646"/></a:accent6>
<a:hlink><a:srgbClr val="0000FF"/></a:hlink>
<a:folHlink><a:srgbClr val="800080"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="YOYOPDF">
<a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="YOYOPDF">
<a:fillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:fillStyleLst>
<a:lnStyleLst>
<a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
<a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
<a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
</a:lnStyleLst>
<a:effectStyleLst>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
<a:effectStyle><a:effectLst/></a:effectStyle>
</a:effectStyleLst>
<a:bgFillStyleLst>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
</a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>`;
}
function pptxSlideXml(x, y, cx, cy){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld>
<p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:pic>
<p:nvPicPr><p:cNvPr id="2" name="Page image"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>
<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>
<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
</p:pic>
</p:spTree>
</p:cSld>
<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}
function pptxSlideRelsXml(imageFileName){
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${imageFileName}"/>
</Relationships>`;
}

/**
 * Builds a .pptx Blob from one raster image per slide.
 * @param {{blob:Blob, widthPx:number, heightPx:number}[]} pages - in slide order.
 * @param {string} [title]
 * @returns {Promise<Blob>}
 */
async function buildPptxFromPageImages(pages, title){
  if(!pages.length) throw new Error("No pages to convert");
  await ensureJSZip();
  const EMU_PER_PX = 9525; // 914400 EMU/inch / 96 px/inch
  const slideW = Math.max(1, Math.round(pages[0].widthPx * EMU_PER_PX));
  const slideH = Math.max(1, Math.round(pages[0].heightPx * EMU_PER_PX));
  const slideAspect = slideW / slideH;

  const zip = new JSZip();
  const slideOverrides = [];
  const sldIdEntries = [];
  const presRelEntries = [];
  for(let i=0;i<pages.length;i++){
    const n = i+1;
    const {widthPx, heightPx, blob} = pages[i];
    const pxAspect = widthPx / heightPx;
    let cx, cy;
    if(pxAspect > slideAspect){ cx = slideW; cy = Math.round(slideW/pxAspect); }
    else { cy = slideH; cx = Math.round(slideH*pxAspect); }
    const x = Math.round((slideW-cx)/2), y = Math.round((slideH-cy)/2);
    zip.file(`ppt/media/image${n}.jpeg`, blob);
    zip.file(`ppt/slides/slide${n}.xml`, pptxSlideXml(x, y, cx, cy));
    zip.file(`ppt/slides/_rels/slide${n}.xml.rels`, pptxSlideRelsXml(`image${n}.jpeg`));
    slideOverrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
    sldIdEntries.push(`<p:sldId id="${256+i}" r:id="rIdSlide${n}"/>`);
    presRelEntries.push(`<Relationship Id="rIdSlide${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/>`);
  }
  zip.file("[Content_Types].xml", pptxContentTypesXml(slideOverrides.join("\n")));
  zip.file("_rels/.rels", pptxPackageRelsXml());
  zip.file("docProps/core.xml", pptxCoreXml(title || "Presentation"));
  zip.file("docProps/app.xml", pptxAppXml(pages.length));
  zip.file("ppt/presentation.xml", pptxPresentationXml(slideW, slideH, sldIdEntries.join("")));
  zip.file("ppt/_rels/presentation.xml.rels", pptxPresentationRelsXml(presRelEntries.join("\n")));
  zip.file("ppt/slideMasters/slideMaster1.xml", pptxSlideMasterXml());
  zip.file("ppt/slideMasters/_rels/slideMaster1.xml.rels", pptxSlideMasterRelsXml());
  zip.file("ppt/slideLayouts/slideLayout1.xml", pptxSlideLayoutXml());
  zip.file("ppt/slideLayouts/_rels/slideLayout1.xml.rels", pptxSlideLayoutRelsXml());
  zip.file("ppt/theme/theme1.xml", pptxThemeXml());
  return zip.generateAsync({type:"blob", mimeType:"application/vnd.openxmlformats-officedocument.presentationml.presentation"});
}
