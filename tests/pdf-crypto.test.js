import {webcrypto} from "node:crypto";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import vm from "node:vm";

const source=readFileSync(resolve("js/core/pdf-crypto.js"),"utf8");
const sandbox={crypto:webcrypto,Uint8Array,DataView};
vm.createContext(sandbox);
vm.runInContext(source,sandbox);

describe("PDF Standard Security Handler",()=>{
  it("protects with AESV2, enforces passwords and preserves permission bits",async()=>{
    const input=new Uint8Array(readFileSync(resolve("tests/fixtures/valid.pdf")));
    const encrypted=await sandbox.encryptPdfBytes(input,{
      userPassword:"open-pass",
      ownerPassword:"owner-pass",
      permissions:{print:false,copy:false,modify:false,annotate:true}
    });
    const structure=Buffer.from(encrypted).toString("latin1");

    expect(structure).toMatch(/\/V 4 \/R 4 \/Length 128/);
    expect(structure).toMatch(/\/CFM \/AESV2/);
    expect(structure).not.toMatch(/\/V 1 \/R 2/);
    const permissions=Number(/\/P (-?\d+)/.exec(structure)[1]);
    expect(permissions&(1<<2)).toBe(0); // print
    expect(permissions&(1<<3)).toBe(0); // modify
    expect(permissions&(1<<4)).toBe(0); // copy
    expect(permissions&(1<<5)).not.toBe(0); // annotations

    await expect(sandbox.tryDecryptSimplePdfBytes(encrypted,"wrong-pass")).resolves.toEqual({notSimple:true});
    const userResult=await sandbox.tryDecryptSimplePdfBytes(encrypted,"open-pass");
    const ownerResult=await sandbox.tryDecryptSimplePdfBytes(encrypted,"owner-pass");
    expect(userResult.bytes).toBeInstanceOf(Uint8Array);
    expect(ownerResult.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(userResult.bytes).toString("latin1")).not.toMatch(/\/Encrypt\s/);
  });

  it("rejects passwords that revision 4 would otherwise truncate or corrupt",async()=>{
    const input=new Uint8Array(readFileSync(resolve("tests/fixtures/valid.pdf")));
    await expect(sandbox.encryptPdfBytes(input,{userPassword:"x".repeat(33)})).rejects.toThrow(/at most 32/);
    await expect(sandbox.encryptPdfBytes(input,{userPassword:"पासवर्ड"})).rejects.toThrow(/Latin-1/);
  });
});
