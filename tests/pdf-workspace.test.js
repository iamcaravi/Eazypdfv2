import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import vm from "node:vm";
import {PDFDocument, degrees} from "pdf-lib";

const source = readFileSync(resolve("js/core/pdf-canvas-widgets.js"), "utf8");
const sandbox = {window:{}, PDFDocument, degrees};
vm.runInNewContext(source, sandbox);
const {Model, buildPdf} = sandbox.window.PDFWorkspace;

function makeWorkspace(){
  return new Model({
    sources:[{id:"document-a", name:"sample.pdf", pageCount:3}],
    pages:[0,1,2].map(sourcePageIndex=>({sourceId:"document-a", sourcePageIndex}))
  });
}

describe("PDFWorkspaceModel", ()=>{
  it("keeps stable source/page state and serializes the active order", ()=>{
    const workspace = makeWorkspace();
    expect(workspace.sources[0]).toMatchObject({id:"document-a", pageCount:3});
    expect(workspace.activePages.map(page=>page.pageIndex)).toEqual([0,1,2]);
    expect(workspace.toPageSpecs()).toEqual([
      {index:0, docIndex:0, rotation:0},
      {index:1, docIndex:0, rotation:0},
      {index:2, docIndex:0, rotation:0}
    ]);
  });

  it("undoes and redoes reorder, rotate, delete and duplicate operations", ()=>{
    const workspace = makeWorkspace();
    const [first, second, third] = workspace.activePages;

    workspace.reorder([third.id, first.id, second.id]);
    workspace.rotatePages([first.id], 90);
    workspace.deletePages([second.id]);
    const [copy] = workspace.duplicatePages([third.id]);

    expect(workspace.toPageSpecs()).toEqual([
      {index:2, docIndex:0, rotation:0},
      {index:2, docIndex:0, rotation:0},
      {index:0, docIndex:0, rotation:90}
    ]);
    expect(copy.duplicateOf).toBe(third.id);

    expect(workspace.undo()).toBe(true);
    expect(workspace.activePages).toHaveLength(2);
    expect(workspace.undo()).toBe(true);
    expect(workspace.activePages).toHaveLength(3);
    expect(workspace.undo()).toBe(true);
    expect(workspace.page(first.id).rotation).toBe(0);
    expect(workspace.undo()).toBe(true);
    expect(workspace.activePages.map(page=>page.sourcePageIndex)).toEqual([0,1,2]);

    expect(workspace.redo()).toBe(true);
    expect(workspace.activePages.map(page=>page.sourcePageIndex)).toEqual([2,0,1]);
  });

  it("keeps selection outside operation history and exposes extension data", ()=>{
    const workspace = makeWorkspace();
    const first = workspace.activePages[0];
    first.extensions.redaction = {regions:[]};
    workspace.setSelected([first.id], true);

    expect(workspace.selectedPages.map(page=>page.id)).toEqual([first.id]);
    expect(workspace.canUndo).toBe(false);
    expect(workspace.toPageSpecs({selectedOnly:true})).toEqual([{index:0, docIndex:0, rotation:0}]);
    expect(first.extensions.redaction).toEqual({regions:[]});
  });

  it("serializes chained workspace state through one export path", async ()=>{
    const sourcePdf = await PDFDocument.create();
    sourcePdf.addPage([200,300]);
    sourcePdf.addPage([300,200]);
    sourcePdf.addPage([400,400]);
    const workspace = makeWorkspace();
    const [first, second, third] = workspace.activePages;

    workspace.reorder([third.id, first.id, second.id]);
    workspace.rotatePages([first.id], 90);
    workspace.duplicatePages([third.id]);
    workspace.deletePages([second.id]);

    const output = await buildPdf(sourcePdf, workspace);
    expect(output.getPageCount()).toBe(3);
    expect(output.getPages().map(page=>page.getWidth())).toEqual([400,400,200]);
    expect(output.getPage(2).getRotation().angle).toBe(90);
  });

  it("selects repeated source pages without collapsing duplicate workspace pages", ()=>{
    const workspace = makeWorkspace();
    const first = workspace.activePages[0];
    workspace.duplicatePages([first.id]);
    workspace.selectOnly(workspace.activePages.filter(page=>page.sourcePageIndex===0).map(page=>page.id));

    expect(workspace.toPageSpecs({selectedOnly:true})).toHaveLength(2);
    expect(workspace.pageSpecsForSourceIndexes([0], {inputOrder:true})).toHaveLength(2);
    expect(workspace.toPageSpecs({excludeSelected:true})).toHaveLength(2);
  });

  it("keeps inserted blank pages in workspace order and history", ()=>{
    const workspace = makeWorkspace();
    workspace.rotatePages([workspace.activePages[0].id], 90);
    workspace.insertPages([{blank:true, width:595, height:842}], 1);

    expect(workspace.toPageSpecs()[1]).toEqual({blank:true, width:595, height:842, rotation:0});
    expect(workspace.undo()).toBe(true);
    expect(workspace.activePages).toHaveLength(3);
    expect(workspace.undo()).toBe(true);
    expect(workspace.activePages[0].rotation).toBe(0);
    expect(workspace.redo()).toBe(true);
    expect(workspace.activePages[0].rotation).toBe(90);
  });

  it("serializes a reordered multi-source organize workspace", async ()=>{
    const firstPdf = await PDFDocument.create();
    firstPdf.addPage([200,300]);
    const secondPdf = await PDFDocument.create();
    secondPdf.addPage([500,300]);
    const workspace = new Model({
      sources:[{id:"a",docIndex:0,pageCount:1},{id:"b",docIndex:1,pageCount:1}],
      pages:[
        {sourceId:"a",docIndex:0,sourcePageIndex:0},
        {sourceId:"b",docIndex:1,sourcePageIndex:0}
      ]
    });
    const [first, second] = workspace.activePages;
    workspace.reorder([second.id, first.id]);

    const output = await buildPdf([firstPdf, secondPdf], workspace);
    expect(output.getPages().map(page=>page.getWidth())).toEqual([500,200]);
  });

  it("preserves source metadata and reorders complete source blocks with undo", ()=>{
    const workspace = new Model({
      sources:[
        {id:"a",docIndex:0,name:"first.pdf",pageCount:2,size:123,type:"application/pdf",lastModified:100,color:"#123456"},
        {id:"b",docIndex:1,name:"second.pdf",pageCount:1,size:456,type:"application/pdf",lastModified:200,color:"#654321"}
      ],
      pages:[
        {sourceId:"a",docIndex:0,sourcePageIndex:0},
        {sourceId:"a",docIndex:0,sourcePageIndex:1},
        {sourceId:"b",docIndex:1,sourcePageIndex:0}
      ]
    });

    expect(workspace.sources[0]).toMatchObject({
      name:"first.pdf", size:123, type:"application/pdf", lastModified:100, color:"#123456"
    });
    expect(workspace.reorderSources([1,0])).toBe(true);
    expect(workspace.activePages.map(page=>[page.docIndex,page.sourcePageIndex])).toEqual([[1,0],[0,0],[0,1]]);
    expect(workspace.undo()).toBe(true);
    expect(workspace.activePages.map(page=>[page.docIndex,page.sourcePageIndex])).toEqual([[0,0],[0,1],[1,0]]);

    workspace.removeSource(0);
    expect(workspace.sources.map(source=>source.docIndex)).toEqual([1]);
    expect(workspace.activePages.map(page=>page.docIndex)).toEqual([1]);
    expect(workspace.canUndo).toBe(false);
  });
});
