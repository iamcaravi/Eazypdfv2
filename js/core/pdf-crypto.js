/* ---------------- PDF Standard Security Handler ----------------
   pdf-lib has no encryption writer. Protect PDF therefore implements the
   standards-defined AES-128 crypt-filter mode from ISO 32000-1 (V=4, R=4,
   AESV2) on top of the existing classic-PDF object rewriter. AES-128 is the
   strongest mode this architecture can implement and verify without adding
   a new PDF engine. It is not labeled AES-256: revisions 5/6 use materially
   different password hashing and validation rules and require broader reader
   interoperability validation than this browser-only project currently has.

   RC4 remains only where revision 4 itself requires it to derive the O/U
   password-validation entries, and in the legacy V=1/R=2 Unlock compatibility
   path. Page content, strings, metadata streams and attachments produced by
   Protect PDF are encrypted with AES-CBC, never 40-bit RC4.

   Scope/known limitations (by design, not oversight):
   - Only operates on a CLASSIC xref table + trailer PDF (not a PDF 1.5+
     cross-reference STREAM) - callers must pass bytes saved with
     `{useObjectStreams:false}` (encrypt) or fall back for files this parser
     doesn't recognize as that shape (decrypt). Every function here throws a
     plain Error on any unexpected structure rather than guessing.
   - Revision 4 passwords are limited to 32 Latin-1/PDFDocEncoding-compatible
     bytes. Unsupported characters and overlong passwords are rejected rather
     than silently truncated or corrupted.
   - Only strings that appear as literal object dictionary content are
     re-encrypted; the overwhelming majority of real content (page content
     streams, fonts, images) lives in STREAM payloads, which this always
     encrypts/decrypts in full. A string this scanner's "genuine `stream`
     keyword" heuristic misses would at worst leave one metadata-ish string
     mismatched with the rest of the encryption scheme (e.g. a garbled
     CreationDate) - never a corrupted page or a security hole. */

/** Encodes a JS string as Latin-1 bytes (each char code truncated to 8 bits) - see file header re: password encoding scope. */
function pdfLatin1Bytes(str, {strict=false}={}){
  if(strict && str.length>32) throw new Error("AES-128 PDF passwords can contain at most 32 characters");
  const out = new Uint8Array(str.length);
  for(let i=0;i<str.length;i++){
    const code = str.charCodeAt(i);
    if(strict && code>0xFF) throw new Error("AES-128 PDF passwords currently support Latin-1 characters only");
    out[i] = code & 0xFF;
  }
  return out;
}
function zeroBytes(...buffers){ buffers.forEach(buffer=>buffer?.fill?.(0)); }

/* ---- MD5 (RFC 1321) - operates on a byte array, returns a 16-byte digest ---- */
const MD5_K = [
  0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
  0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
  0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
  0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
  0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
  0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
  0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
  0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391,
];
const MD5_S = [
  7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
  5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
  4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
  6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21,
];
function md5RotL(x, c){ return (x<<c) | (x>>>(32-c)); }
function md5(bytes){
  const msgLen = bytes.length;
  const totalLenBits = msgLen * 8; // exact for any realistic PDF size (well under 2^53)
  const paddedLen = (Math.floor((msgLen + 8) / 64) + 1) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[msgLen] = 0x80;
  // 64-bit little-endian bit-length, written as two 32-bit LE halves (safe
  // since JS numbers are exact integers well past any real PDF's bit length).
  const lo = totalLenBits >>> 0;
  const hi = Math.floor(totalLenBits / 0x100000000) >>> 0;
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen-8, lo, true);
  dv.setUint32(paddedLen-4, hi, true);

  let a0=0x67452301, b0=0xefcdab89, c0=0x98badcfe, d0=0x10325476;
  const M = new Uint32Array(16);
  for(let chunk=0; chunk<paddedLen; chunk+=64){
    for(let j=0;j<16;j++) M[j] = dv.getUint32(chunk + j*4, true);
    let A=a0,B=b0,C=c0,D=d0;
    for(let i=0;i<64;i++){
      let F, g;
      if(i<16){ F = (B & C) | (~B & D); g = i; }
      else if(i<32){ F = (D & B) | (~D & C); g = (5*i+1) % 16; }
      else if(i<48){ F = B ^ C ^ D; g = (3*i+5) % 16; }
      else { F = C ^ (B | (~D)); g = (7*i) % 16; }
      F = (F + A + MD5_K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + md5RotL(F, MD5_S[i])) | 0;
    }
    a0 = (a0+A)|0; b0=(b0+B)|0; c0=(c0+C)|0; d0=(d0+D)|0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0>>>0, true); odv.setUint32(4, b0>>>0, true);
  odv.setUint32(8, c0>>>0, true); odv.setUint32(12, d0>>>0, true);
  return out;
}

/* ---- RC4 - symmetric: the same function encrypts and decrypts ---- */
function rc4(keyBytes, dataBytes){
  const S = new Uint8Array(256);
  for(let i=0;i<256;i++) S[i]=i;
  let j=0;
  const klen = keyBytes.length;
  for(let i=0;i<256;i++){
    j = (j + S[i] + keyBytes[i % klen]) & 0xFF;
    const t=S[i]; S[i]=S[j]; S[j]=t;
  }
  const out = new Uint8Array(dataBytes.length);
  let i=0; j=0;
  for(let n=0;n<dataBytes.length;n++){
    i = (i+1) & 0xFF;
    j = (j+S[i]) & 0xFF;
    const t=S[i]; S[i]=S[j]; S[j]=t;
    out[n] = dataBytes[n] ^ S[(S[i]+S[j]) & 0xFF];
  }
  return out;
}

/* ---- Standard Security Handler algorithms (ISO 32000-1 7.6.3, Revision 2) ---- */
const PDF_PAD = new Uint8Array([
  0x28,0xBF,0x4E,0x5E,0x4E,0x75,0x8A,0x41,0x64,0x00,0x4E,0x56,0xFF,0xFA,0x01,0x08,
  0x2E,0x2E,0x00,0xB6,0xD0,0x68,0x3E,0x80,0x2F,0x0C,0xA9,0xFE,0x64,0x53,0x69,0x7A,
]);
function padPassword(pwBytes){
  const out = new Uint8Array(32);
  const n = Math.min(pwBytes.length, 32);
  out.set(pwBytes.subarray(0, n));
  out.set(PDF_PAD.subarray(0, 32-n), n);
  return out;
}
/** Algorithm 3 (O value) - revision 2, no rehash. */
function computeO(ownerPwBytes, userPwBytes){
  const opw = padPassword(ownerPwBytes);
  const digest = md5(opw);
  const rc4Key = digest.subarray(0,5); // 40-bit
  const upw = padPassword(userPwBytes);
  return rc4(rc4Key, upw);
}
/** Algorithm 2 (encryption/file key) - revision 2, 5-byte (40-bit) key, no 50x rehash. */
function computeFileKey(userPwBytes, oBytes, permissionsInt, idBytes){
  const padded = padPassword(userPwBytes);
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, permissionsInt, true);
  const concat = new Uint8Array(padded.length + oBytes.length + 4 + idBytes.length);
  let off=0;
  concat.set(padded, off); off+=padded.length;
  concat.set(oBytes, off); off+=oBytes.length;
  concat.set(pBytes, off); off+=4;
  concat.set(idBytes, off);
  return md5(concat).subarray(0,5);
}
/** Algorithm 4 (U value) - revision 2: RC4 of the padding string itself with the file key. */
function computeU(fileKeyBytes){
  return rc4(fileKeyBytes, PDF_PAD);
}
/** Per-object key (7.6.2, algorithm 1 step a/b), key length min(fileKeyLen+5,16). */
function computeObjectKey(fileKeyBytes, objNum, genNum){
  const extra = new Uint8Array(5);
  extra[0]=objNum & 0xFF; extra[1]=(objNum>>8)&0xFF; extra[2]=(objNum>>16)&0xFF;
  extra[3]=genNum & 0xFF; extra[4]=(genNum>>8)&0xFF;
  const concat = new Uint8Array(fileKeyBytes.length + 5);
  concat.set(fileKeyBytes, 0); concat.set(extra, fileKeyBytes.length);
  const keyLen = Math.min(fileKeyBytes.length + 5, 16);
  return md5(concat).subarray(0, keyLen);
}
/** Permission bits (Table 22): bits 1-2 remain 0 and reserved high bits remain 1. */
function computePermissionsInt({print=true, modify=true, copy=true, annotate=true}={}){
  let p = 0xFFFFFFFC; // all 1s except bit1/bit2
  if(!print){ p &= ~(1<<2); p &= ~(1<<11); } // low/high-quality printing
  if(!modify){ p &= ~(1<<3); p &= ~(1<<8); p &= ~(1<<10); } // edit, fill forms, assemble
  if(!copy) p &= ~(1<<4);     // bit position 5
  if(!annotate) p &= ~(1<<5); // bit position 6
  return p|0; // signed 32-bit, as written into the PDF integer
}

/* ---- Revision 4 password and AES-128 key algorithms ---- */
function xorKey(key, value){
  const out = new Uint8Array(key.length);
  for(let i=0;i<key.length;i++) out[i]=key[i]^value;
  return out;
}
function ownerKeyR4(ownerPwBytes){
  const padded=padPassword(ownerPwBytes);
  let digest = md5(padded);
  zeroBytes(padded);
  for(let i=0;i<50;i++) digest=md5(digest);
  return digest.subarray(0,16);
}
function computeOwnerEntryR4(ownerPwBytes, userPwBytes){
  const key = ownerKeyR4(ownerPwBytes);
  let value = padPassword(userPwBytes);
  value = rc4(key, value);
  for(let i=1;i<=19;i++){ const iterationKey=xorKey(key,i); value=rc4(iterationKey,value); zeroBytes(iterationKey); }
  zeroBytes(key);
  return value;
}
function recoverUserPasswordR4(ownerPasswordBytes, ownerEntry){
  const key = ownerKeyR4(ownerPasswordBytes);
  let value = ownerEntry.slice();
  for(let i=19;i>=0;i--){ const iterationKey=xorKey(key,i); value=rc4(iterationKey,value); zeroBytes(iterationKey); }
  zeroBytes(key);
  return value;
}
function computeFileKeyR4(userPwBytes, oBytes, permissionsInt, idBytes, encryptMetadata=true){
  const padded = padPassword(userPwBytes);
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, permissionsInt, true);
  const extra = encryptMetadata ? 0 : 4;
  const concat = new Uint8Array(padded.length+oBytes.length+4+idBytes.length+extra);
  let off=0;
  concat.set(padded,off); off+=padded.length;
  concat.set(oBytes,off); off+=oBytes.length;
  concat.set(pBytes,off); off+=4;
  concat.set(idBytes,off); off+=idBytes.length;
  if(!encryptMetadata) concat.set([0xFF,0xFF,0xFF,0xFF],off);
  let digest=md5(concat);
  for(let i=0;i<50;i++) digest=md5(digest.subarray(0,16));
  zeroBytes(padded,pBytes,concat);
  return digest.subarray(0,16);
}
function computeUserEntryR4(fileKeyBytes, idBytes){
  const input = new Uint8Array(PDF_PAD.length+idBytes.length);
  input.set(PDF_PAD); input.set(idBytes,PDF_PAD.length);
  let value=md5(input);
  value=rc4(fileKeyBytes,value);
  for(let i=1;i<=19;i++){ const iterationKey=xorKey(fileKeyBytes,i); value=rc4(iterationKey,value); zeroBytes(iterationKey); }
  const out=new Uint8Array(32);
  out.set(value,0); // final 16 bytes are arbitrary padding for R>=3
  zeroBytes(input,value);
  return out;
}
function first16Equal(a,b){
  if(!a||!b||a.length<16||b.length<16) return false;
  let diff=0;
  for(let i=0;i<16;i++) diff|=a[i]^b[i];
  return diff===0;
}
function computeAesObjectKey(fileKeyBytes,objNum,genNum){
  const extra=new Uint8Array(9);
  extra[0]=objNum&0xFF; extra[1]=(objNum>>8)&0xFF; extra[2]=(objNum>>16)&0xFF;
  extra[3]=genNum&0xFF; extra[4]=(genNum>>8)&0xFF;
  extra.set([0x73,0x41,0x6C,0x54],5); // required AES "sAlT" marker
  const input=new Uint8Array(fileKeyBytes.length+extra.length);
  input.set(fileKeyBytes); input.set(extra,fileKeyBytes.length);
  const key=md5(input).subarray(0,16);
  zeroBytes(extra,input);
  return key;
}
async function aesCbcEncrypt(keyBytes,plainBytes){
  if(!globalThis.crypto?.subtle) throw new Error("AES encryption is not available in this browser context");
  const iv=crypto.getRandomValues(new Uint8Array(16));
  const key=await crypto.subtle.importKey("raw",keyBytes,{name:"AES-CBC"},false,["encrypt"]);
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:"AES-CBC",iv},key,plainBytes));
  const out=new Uint8Array(iv.length+encrypted.length);
  out.set(iv); out.set(encrypted,iv.length);
  zeroBytes(iv,encrypted);
  return out;
}
async function aesCbcDecrypt(keyBytes,cipherBytes){
  if(!globalThis.crypto?.subtle || cipherBytes.length<32 || cipherBytes.length%16!==0) throw new Error("Invalid AES-encrypted PDF object");
  const iv=cipherBytes.slice(0,16), payload=cipherBytes.slice(16);
  const key=await crypto.subtle.importKey("raw",keyBytes,{name:"AES-CBC"},false,["decrypt"]);
  try{ return new Uint8Array(await crypto.subtle.decrypt({name:"AES-CBC",iv},key,payload)); }
  finally{ zeroBytes(iv,payload); }
}

/* ---------------- Binary-safe string <-> bytes ----------------
   PDF structure (object numbers, keywords, dict syntax) is pure ASCII, but
   stream payloads and string values are arbitrary bytes - representing the
   whole file as a JS "binary string" (one JS char == one byte, Latin-1
   round-trip) lets regex/string tools do the structural parsing without
   ever corrupting the bytes it doesn't touch. Chunked to avoid a call-stack
   blowout from spreading a huge typed array into String.fromCharCode. */
function bytesToBinaryString(bytes){
  let s = "";
  const CHUNK = 0x8000;
  for(let i=0;i<bytes.length;i+=CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i+CHUNK));
  return s;
}
function binaryStringToBytes(str){
  const out = new Uint8Array(str.length);
  for(let i=0;i<str.length;i++) out[i] = str.charCodeAt(i) & 0xFF;
  return out;
}
function bytesToHexPdfString(bytes){
  let s = "<";
  for(let i=0;i<bytes.length;i++) s += bytes[i].toString(16).padStart(2,"0");
  return s + ">";
}
function hexPairsToBytes(hex){
  const clean = (hex||"").replace(/[^0-9A-Fa-f]/g, "");
  const out = new Uint8Array(Math.floor(clean.length/2));
  for(let i=0;i<out.length;i++) out[i] = parseInt(clean.substr(i*2,2), 16);
  return out;
}

/* ---------------- Minimal PDF token scanner (strings only) ----------------
   Deliberately not a full PDF-syntax parser: it only needs to find literal
   `(...)` and hex `<...>` STRING tokens inside a dictionary/array region and
   leave everything else (names, numbers, `<<`/`>>`, `[`/`]`, comments)
   byte-for-byte untouched - see file header for why that's sufficient here. */
function parseLiteralStringBin(text, start){
  let i = start+1, depth=1;
  const out=[];
  while(i<text.length && depth>0){
    const c = text.charCodeAt(i);
    if(c===0x5C){ // backslash
      const n = text.charCodeAt(i+1);
      if(n===0x6E){ out.push(0x0A); i+=2; }
      else if(n===0x72){ out.push(0x0D); i+=2; }
      else if(n===0x74){ out.push(0x09); i+=2; }
      else if(n===0x62){ out.push(0x08); i+=2; }
      else if(n===0x66){ out.push(0x0C); i+=2; }
      else if(n===0x28){ out.push(0x28); i+=2; }
      else if(n===0x29){ out.push(0x29); i+=2; }
      else if(n===0x5C){ out.push(0x5C); i+=2; }
      else if(n===0x0D){ i+=2; if(text.charCodeAt(i)===0x0A) i++; } // line continuation
      else if(n===0x0A){ i+=2; }
      else if(n>=0x30 && n<=0x37){
        let val=0, cnt=0, j=i+1;
        while(cnt<3 && text.charCodeAt(j)>=0x30 && text.charCodeAt(j)<=0x37){ val=val*8+(text.charCodeAt(j)-0x30); j++; cnt++; }
        out.push(val & 0xFF); i=j;
      } else { out.push(n); i+=2; } // unrecognized escape: backslash ignored, char literal
    } else if(c===0x28){ depth++; out.push(c); i++; }
    else if(c===0x29){ depth--; i++; if(depth>0) out.push(c); }
    else { out.push(c); i++; }
  }
  return { bytes: Uint8Array.from(out), end: i };
}
function isHexDigitCode(c){ return (c>=0x30&&c<=0x39)||(c>=0x41&&c<=0x46)||(c>=0x61&&c<=0x66); }
function parseHexStringBin(text, start){
  let i = start+1;
  const hexChars = [];
  while(i<text.length && text.charCodeAt(i)!==0x3E){ // '>'
    const c = text.charCodeAt(i);
    if(isHexDigitCode(c)) hexChars.push(text[i]);
    i++;
  }
  i++; // consume '>'
  if(hexChars.length % 2 === 1) hexChars.push("0");
  const out = new Uint8Array(hexChars.length/2);
  for(let k=0;k<out.length;k++) out[k] = parseInt(hexChars[2*k]+hexChars[2*k+1], 16);
  return { bytes: out, end: i };
}
/** Replaces every string token in `text` with RC4(objKey, decodedBytes) re-encoded as a hex string. RC4 is its own inverse, so this is used for both encrypt and decrypt. */
function rc4TransformPdfObjectText(text, objKey){
  let out = "";
  let i = 0;
  while(i < text.length){
    const c = text.charCodeAt(i);
    if(c===0x25){ // '%' comment to end of line
      let j=i;
      while(j<text.length && text.charCodeAt(j)!==0x0A && text.charCodeAt(j)!==0x0D) j++;
      out += text.slice(i,j); i=j;
    } else if(c===0x28){ // '('
      const {bytes, end} = parseLiteralStringBin(text, i);
      out += bytesToHexPdfString(rc4(objKey, bytes));
      i = end;
    } else if(c===0x3C){ // '<'
      if(text.charCodeAt(i+1)===0x3C){ out += "<<"; i+=2; }
      else {
        const {bytes, end} = parseHexStringBin(text, i);
        out += bytesToHexPdfString(rc4(objKey, bytes));
        i = end;
      }
    } else { out += text[i]; i++; }
  }
  return out;
}

/** Encrypts/decrypts every PDF string token with AES-CBC and hex-encodes the result. */
async function aesTransformPdfObjectText(text, objKey, decrypt=false){
  let out="", i=0;
  while(i<text.length){
    const c=text.charCodeAt(i);
    if(c===0x25){
      let j=i;
      while(j<text.length && text.charCodeAt(j)!==0x0A && text.charCodeAt(j)!==0x0D) j++;
      out+=text.slice(i,j); i=j;
    }else if(c===0x28){
      const parsed=parseLiteralStringBin(text,i);
      const transformed=decrypt ? await aesCbcDecrypt(objKey,parsed.bytes) : await aesCbcEncrypt(objKey,parsed.bytes);
      out+=bytesToHexPdfString(transformed); zeroBytes(transformed); i=parsed.end;
    }else if(c===0x3C){
      if(text.charCodeAt(i+1)===0x3C){ out+="<<"; i+=2; }
      else{
        const parsed=parseHexStringBin(text,i);
        const transformed=decrypt ? await aesCbcDecrypt(objKey,parsed.bytes) : await aesCbcEncrypt(objKey,parsed.bytes);
        out+=bytesToHexPdfString(transformed); zeroBytes(transformed); i=parsed.end;
      }
    }else{
      out+=text[i]; i++;
    }
  }
  return out;
}

/* ---------------- Object discovery + whole-body transform ---------------- */
/** Finds every top-level indirect object in a classic (non-xref-stream) PDF body. Anchored to real line starts with a strict "N G obj" shape to minimize the (already tiny) chance of matching stray bytes inside a binary stream payload. */
function findIndirectObjects(bin){
  const objRe = /(?:^|[\r\n])(\d+) (\d+) obj\b/gm;
  const objects = [];
  let m;
  while((m = objRe.exec(bin))){
    const num = parseInt(m[1],10), gen = parseInt(m[2],10);
    const headerStart = m.index + (m[0][0]==="\r"||m[0][0]==="\n" ? 1 : 0);
    const bodyStart = objRe.lastIndex;
    const endobjIdx = bin.indexOf("endobj", bodyStart);
    if(endobjIdx === -1) continue;
    objects.push({num, gen, headerStart, bodyStart, bodyEnd: endobjIdx, endobjEnd: endobjIdx+6});
  }
  return objects;
}
function findPlainIntObjects(bin, objects){
  const map = new Map();
  for(const o of objects){
    const bodyText = bin.slice(o.bodyStart, o.bodyEnd).trim();
    if(/^\d+$/.test(bodyText)) map.set(o.num+"_"+o.gen, parseInt(bodyText,10));
  }
  return map;
}
/** Splits one object's body into header/stream (if any), RC4-transforms strings in the header and the raw stream payload with the same per-object key, and returns the rewritten body text. Symmetric: works for both encrypt and decrypt. */
function rc4TransformObjectBody(body, objKey, plainIntObjects){
  let streamKwIdx = -1, eol = "";
  const re = /stream(\r\n|\n)/g;
  let mm;
  while((mm = re.exec(body))){
    const before = mm.index>0 ? body.charCodeAt(mm.index-1) : 0x0A;
    if(before===0x0A||before===0x0D||before===0x20||before===0x09||before===0x3E){
      streamKwIdx = mm.index; eol = mm[1]; break;
    }
  }
  if(streamKwIdx === -1) return rc4TransformPdfObjectText(body, objKey);

  const header = body.slice(0, streamKwIdx);
  const payloadStart = streamKwIdx + 6 + eol.length;
  let length = null;
  const indirectM = /\/Length\s+(\d+)\s+(\d+)\s+R\b/.exec(header);
  if(indirectM){
    const v = plainIntObjects.get(indirectM[1]+"_"+indirectM[2]);
    if(v!=null) length = v;
  }
  if(length == null){
    const directM = /\/Length\s+(\d+)\b/.exec(header);
    if(directM) length = parseInt(directM[1],10);
  }
  const endstreamIdx = body.indexOf("endstream", payloadStart);
  let payloadEnd;
  if(length!=null && payloadStart+length <= body.length){
    payloadEnd = payloadStart + length;
  } else if(endstreamIdx !== -1){
    payloadEnd = endstreamIdx;
    if(payloadEnd>0 && body.charCodeAt(payloadEnd-1)===0x0A){ payloadEnd--; if(payloadEnd>0 && body.charCodeAt(payloadEnd-1)===0x0D) payloadEnd--; }
  } else {
    throw new Error("Could not determine a stream's length while processing this PDF's structure");
  }
  const payload = body.slice(payloadStart, payloadEnd);
  const tail = body.slice(payloadEnd);
  const newHeader = rc4TransformPdfObjectText(header, objKey);
  const newPayload = bytesToBinaryString(rc4(objKey, binaryStringToBytes(payload)));
  return newHeader + "stream" + eol + newPayload + tail;
}

/** AES counterpart to rc4TransformObjectBody. AES changes payload length, so an indirect or direct /Length is normalized to the transformed byte count. */
async function aesTransformObjectBody(body,objKey,plainIntObjects,decrypt=false){
  let streamKwIdx=-1,eol="";
  const re=/stream(\r\n|\n)/g;
  let mm;
  while((mm=re.exec(body))){
    const before=mm.index>0 ? body.charCodeAt(mm.index-1) : 0x0A;
    if(before===0x0A||before===0x0D||before===0x20||before===0x09||before===0x3E){ streamKwIdx=mm.index; eol=mm[1]; break; }
  }
  if(streamKwIdx===-1) return aesTransformPdfObjectText(body,objKey,decrypt);

  let header=body.slice(0,streamKwIdx);
  const payloadStart=streamKwIdx+6+eol.length;
  let length=null;
  const indirectM=/\/Length\s+(\d+)\s+(\d+)\s+R\b/.exec(header);
  if(indirectM){
    const value=plainIntObjects.get(indirectM[1]+"_"+indirectM[2]);
    if(value!=null) length=value;
  }
  if(length==null){
    const directM=/\/Length\s+(\d+)\b/.exec(header);
    if(directM) length=parseInt(directM[1],10);
  }
  const endstreamIdx=body.indexOf("endstream",payloadStart);
  let payloadEnd;
  if(length!=null && payloadStart+length<=body.length) payloadEnd=payloadStart+length;
  else if(endstreamIdx!==-1){
    payloadEnd=endstreamIdx;
    if(payloadEnd>0 && body.charCodeAt(payloadEnd-1)===0x0A){ payloadEnd--; if(payloadEnd>0&&body.charCodeAt(payloadEnd-1)===0x0D) payloadEnd--; }
  }else throw new Error("Could not determine a stream's length while processing this PDF's structure");

  const input=binaryStringToBytes(body.slice(payloadStart,payloadEnd));
  const transformed=decrypt ? await aesCbcDecrypt(objKey,input) : await aesCbcEncrypt(objKey,input);
  header=header.replace(/\/Length\s+(?:\d+\s+\d+\s+R|\d+)\b/,`/Length ${transformed.length}`);
  const newHeader=await aesTransformPdfObjectText(header,objKey,decrypt);
  const result=newHeader+"stream"+eol+bytesToBinaryString(transformed)+body.slice(payloadEnd);
  zeroBytes(input,transformed);
  return result;
}

/** Locates the ORIGINAL trailer dict text (classic `trailer<<...>>` form only - see file header scope note) and pulls out /Root, /Info, and /ID so a rebuild can carry them forward. Throws if this doesn't look like a classic-trailer PDF. */
function readOriginalTrailer(bin){
  const idx = bin.lastIndexOf("trailer");
  if(idx === -1) throw new Error("This PDF doesn't use a classic cross-reference table, which this feature requires");
  const openIdx = bin.indexOf("<<", idx);
  if(openIdx === -1) throw new Error("Could not read this PDF's trailer dictionary");
  // Balanced-bracket scan (not a lazy regex) - the trailer can itself
  // contain a NESTED `<<...>>` dict (e.g. an inline /Encrypt dict, exactly
  // what this module's own encryptPdfBytes() writes), which a naive
  // `<<([\s\S]*?)>>` would truncate at the first, inner `>>` instead of the
  // outer trailer's real close. A hex string's content can never itself
  // contain literal "<<"/">>" (only hex digits/whitespace are legal between
  // its single-angle-bracket delimiters), so counting these two-char
  // tokens is safe here.
  let depth=0, i=openIdx, closeIdx=-1;
  while(i<bin.length-1){
    if(bin[i]==="<" && bin[i+1]==="<"){ depth++; i+=2; continue; }
    if(bin[i]===">" && bin[i+1]===">"){ depth--; i+=2; if(depth===0){ closeIdx=i-2; break; } continue; }
    i++;
  }
  if(closeIdx===-1) throw new Error("Could not read this PDF's trailer dictionary");
  const dict = bin.slice(openIdx+2, closeIdx);
  const rootM = /\/Root\s+(\d+)\s+(\d+)\s+R\b/.exec(dict);
  if(!rootM) throw new Error("Could not find this PDF's document catalog reference");
  const infoM = /\/Info\s+(\d+)\s+(\d+)\s+R\b/.exec(dict);
  const idM = /\/ID\s*\[\s*<([0-9A-Fa-f]*)>/.exec(dict);
  return {
    rootRef: `${rootM[1]} ${rootM[2]} R`,
    infoRef: infoM ? `${infoM[1]} ${infoM[2]} R` : null,
    idHex: idM ? idM[1] : null,
    dictText: dict,
  };
}

/** Finds and resolves this PDF's existing /Encrypt dictionary (direct or indirect) for the Unlock fast path. Returns null if there's no encryption, or if the structure isn't one this module recognizes. */
function readExistingEncryptDict(bin){
  let trailer;
  try{ trailer = readOriginalTrailer(bin); } catch(e){ return null; }
  const encM = /\/Encrypt\s+(?:(\d+)\s+(\d+)\s+R|(<<[\s\S]*?>>))/.exec(trailer.dictText);
  if(!encM) return null;
  let dictText;
  if(encM[3]){
    dictText = encM[3];
  } else {
    const objs = findIndirectObjects(bin);
    const target = objs.find(o=>o.num===parseInt(encM[1],10) && o.gen===parseInt(encM[2],10));
    if(!target) return null;
    dictText = bin.slice(target.bodyStart, target.bodyEnd);
  }
  const filterM = /\/Filter\s*\/(\w+)/.exec(dictText);
  const vM = /\/V\s+(\d+)/.exec(dictText);
  const rM = /\/R\s+(\d+)/.exec(dictText);
  const pM = /\/P\s+(-?\d+)/.exec(dictText);
  const cfmM = /\/CFM\s*\/(\w+)/.exec(dictText);
  const encryptMetadataM = /\/EncryptMetadata\s+(true|false)/.exec(dictText);
  const oM = /\/O\s*(\([\s\S]*?[^\\]\)|<[0-9A-Fa-f\s]*>)/.exec(dictText);
  const uM = /\/U\s*(\([\s\S]*?[^\\]\)|<[0-9A-Fa-f\s]*>)/.exec(dictText);
  if(!filterM || filterM[1]!=="Standard" || !vM || !rM || !pM || !oM || !uM || !trailer.idHex) return null;
  function decodeStringToken(tok){
    if(tok[0]==="<") return parseHexStringBin(tok, 0).bytes;
    return parseLiteralStringBin(tok, 0).bytes;
  }
  return {
    V: parseInt(vM[1],10), R: parseInt(rM[1],10), P: parseInt(pM[1],10),
    O: decodeStringToken(oM[1]), U: decodeStringToken(uM[1]),
    CFM: cfmM?.[1] || null, encryptMetadata: encryptMetadataM?.[1]!=="false",
    idBytes: hexPairsToBytes(trailer.idHex),
    trailer,
  };
}

/** Legacy-only rebuild used to unlock earlier V1/R2 files without flattening them. */
function rebuildPdfWithRc4Transform(pdfBytes, fileKey, trailerFields){
  const bin = bytesToBinaryString(pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes));
  const objects = findIndirectObjects(bin);
  if(!objects.length) throw new Error("No PDF objects found - this file may not be a valid PDF");
  const plainIntObjects = findPlainIntObjects(bin, objects);
  objects.sort((a,b)=>a.headerStart-b.headerStart);

  const headerText = bin.slice(0, objects[0].headerStart);
  let out = headerText;
  const offsetByNum = new Map();
  let maxNum = 0;
  for(const o of objects){
    if(o.num > maxNum) maxNum = o.num;
    offsetByNum.set(o.num, out.length);
    const objKey = computeObjectKey(fileKey, o.num, o.gen);
    const body = bin.slice(o.bodyStart, o.bodyEnd);
    const newBody = rc4TransformObjectBody(body, objKey, plainIntObjects);
    out += `${o.num} ${o.gen} obj\n${newBody}\nendobj\n`;
  }
  const xrefOffset = out.length;
  const count = maxNum + 1;
  let xref = `xref\n0 ${count}\n`;
  xref += "0000000000 65535 f \n";
  for(let n=1;n<count;n++){
    if(offsetByNum.has(n)) xref += String(offsetByNum.get(n)).padStart(10,"0") + " 00000 n \n";
    else xref += "0000000000 65535 f \n";
  }
  out += xref;
  out += `trailer\n<< /Size ${count} ${trailerFields} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return binaryStringToBytes(out);
}

/** Rebuilds a classic PDF while applying AESV2 to every object's strings and streams. */
async function rebuildPdfWithAesTransform(pdfBytes,fileKey,trailerFields,decrypt=false){
  const bin=bytesToBinaryString(pdfBytes instanceof Uint8Array?pdfBytes:new Uint8Array(pdfBytes));
  const objects=findIndirectObjects(bin);
  if(!objects.length) throw new Error("No PDF objects found - this file may not be a valid PDF");
  const plainIntObjects=findPlainIntObjects(bin,objects);
  objects.sort((a,b)=>a.headerStart-b.headerStart);
  let headerText=bin.slice(0,objects[0].headerStart);
  if(!decrypt) headerText=headerText.replace(/^%PDF-(\d+)\.(\d+)/,(_m,major,minor)=>Number(major)>1||Number(minor)>=6?_m:"%PDF-1.6");
  let out=headerText;
  const offsetByNum=new Map();
  let maxNum=0;
  for(const object of objects){
    maxNum=Math.max(maxNum,object.num);
    offsetByNum.set(object.num,out.length);
    const objectKey=computeAesObjectKey(fileKey,object.num,object.gen);
    const newBody=await aesTransformObjectBody(bin.slice(object.bodyStart,object.bodyEnd),objectKey,plainIntObjects,decrypt);
    zeroBytes(objectKey);
    out+=`${object.num} ${object.gen} obj\n${newBody}\nendobj\n`;
  }
  const xrefOffset=out.length,count=maxNum+1;
  let xref=`xref\n0 ${count}\n0000000000 65535 f \n`;
  for(let n=1;n<count;n++) xref+=offsetByNum.has(n)?String(offsetByNum.get(n)).padStart(10,"0")+" 00000 n \n":"0000000000 65535 f \n";
  out+=xref+`trailer\n<< /Size ${count} ${trailerFields} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return binaryStringToBytes(out);
}

/**
 * Encrypts a PDF with the Standard Security Handler (AES-128, V=4/R=4/AESV2).
 * `pdfBytes` MUST come from `PDFDocument.save({useObjectStreams:false})` -
 * see file header for why. Caller is responsible for the runtime self-check
 * (re-opening the result with pdf.js + the same password) since that needs
 * pdfjsLib, which this pure module deliberately doesn't depend on.
 * @param {Uint8Array} pdfBytes
 * @param {{userPassword:string, ownerPassword?:string, permissions?:object}} opts
 * @returns {Promise<Uint8Array>}
 */
async function encryptPdfBytes(pdfBytes, {userPassword, ownerPassword, permissions}={}){
  if(!userPassword) throw new Error("An open password is required");
  const userPwBytes=pdfLatin1Bytes(userPassword,{strict:true});
  // A blank owner password gets an unpersisted random owner credential so
  // the open password does not silently grant owner-level permission bypass.
  const ownerPwBytes=ownerPassword ? pdfLatin1Bytes(ownerPassword,{strict:true}) : crypto.getRandomValues(new Uint8Array(32));
  const idBytes=crypto.getRandomValues(new Uint8Array(16));
  const P=computePermissionsInt(permissions);
  const O=computeOwnerEntryR4(ownerPwBytes,userPwBytes);
  const fileKey=computeFileKeyR4(userPwBytes,O,P,idBytes,true);
  const U=computeUserEntryR4(fileKey,idBytes);
  try{
    const idHex=bytesToHexPdfString(idBytes);
    const origTrailer=readOriginalTrailer(bytesToBinaryString(pdfBytes));
    const trailerFields=`/Root ${origTrailer.rootRef}`
      +(origTrailer.infoRef?` /Info ${origTrailer.infoRef}`:"")
      +` /Encrypt << /Filter /Standard /V 4 /R 4 /Length 128 /O ${bytesToHexPdfString(O)} /U ${bytesToHexPdfString(U)} /P ${P} /EncryptMetadata true /CF << /StdCF << /Type /CryptFilter /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF >>`
      +` /ID [${idHex} ${idHex}]`;
    return await rebuildPdfWithAesTransform(pdfBytes,fileKey,trailerFields,false);
  }finally{
    zeroBytes(userPwBytes,ownerPwBytes,idBytes,O,U,fileKey);
  }
}

/**
 * Structure-preserving decrypt fast path for Unlock PDF - ONLY handles the
 * AESV2 V=4/R=4 output produced above and the previous V=1/R=2 output for
 * backward compatibility. Returns `{notSimple:true}` for other schemes so
 * falls back to the pdf.js render-based flatten path, which covers every
 * encryption variant pdf.js itself supports. The password itself is assumed
 * already verified by the caller (pdf.js's own getDocument({password})) -
 * this only re-confirms it via the same U-value check the PDF spec itself
 * uses, which doubles as a sanity check on this module's own O/U parsing.
 * @param {Uint8Array} pdfBytes
 * @param {string} password
 * @returns {Promise<{bytes:Uint8Array}|{notSimple:true}>}
 */
async function tryDecryptSimplePdfBytes(pdfBytes, password){
  try{
    const bin = bytesToBinaryString(pdfBytes);
    const enc = readExistingEncryptDict(bin);
    if(!enc) return {notSimple:true};
    if(enc.V===4 && enc.R===4 && enc.CFM==="AESV2"){
      const pwBytes=pdfLatin1Bytes(password||"",{strict:true});
      let recoveredUser=null;
      let fileKey=computeFileKeyR4(pwBytes,enc.O,enc.P,enc.idBytes,enc.encryptMetadata);
      let expectedU=computeUserEntryR4(fileKey,enc.idBytes);
      if(!first16Equal(expectedU,enc.U)){
        zeroBytes(fileKey,expectedU);
        recoveredUser=recoverUserPasswordR4(pwBytes,enc.O);
        fileKey=computeFileKeyR4(recoveredUser,enc.O,enc.P,enc.idBytes,enc.encryptMetadata);
        expectedU=computeUserEntryR4(fileKey,enc.idBytes);
        if(!first16Equal(expectedU,enc.U)){ zeroBytes(pwBytes,recoveredUser,fileKey,expectedU); return {notSimple:true}; }
      }
      const trailerFields=`/Root ${enc.trailer.rootRef}`+(enc.trailer.infoRef?` /Info ${enc.trailer.infoRef}`:"")
        +` /ID [${bytesToHexPdfString(enc.idBytes)} ${bytesToHexPdfString(enc.idBytes)}]`;
      try{ return {bytes:await rebuildPdfWithAesTransform(pdfBytes,fileKey,trailerFields,true)}; }
      finally{ zeroBytes(pwBytes,recoveredUser,fileKey,expectedU); }
    }
    if(enc.V!==1 || enc.R!==2) return {notSimple:true};
    const pwBytes = pdfLatin1Bytes(password || "");
    let fileKey = computeFileKey(pwBytes, enc.O, enc.P, enc.idBytes);
    let recoveredUserPw=null;
    try{
      if(bytesToHexPdfString(computeU(fileKey)) !== bytesToHexPdfString(enc.U)){
        // Supplied password didn't work as the USER password - try it as the
        // OWNER password (Algorithm 7: recover the user password from O, then
        // derive the file key from that).
        const opw = padPassword(pwBytes);
        const rc4Key = md5(opw).subarray(0,5);
        recoveredUserPw = rc4(rc4Key, enc.O);
        zeroBytes(fileKey,opw,rc4Key);
        fileKey = computeFileKey(recoveredUserPw, enc.O, enc.P, enc.idBytes);
        if(bytesToHexPdfString(computeU(fileKey)) !== bytesToHexPdfString(enc.U)) return {notSimple:true};
      }
      const trailerFields = `/Root ${enc.trailer.rootRef}` + (enc.trailer.infoRef ? ` /Info ${enc.trailer.infoRef}` : "")
        + ` /ID [${bytesToHexPdfString(enc.idBytes)} ${bytesToHexPdfString(enc.idBytes)}]`;
      return {bytes:rebuildPdfWithRc4Transform(pdfBytes,fileKey,trailerFields)};
    }finally{
      zeroBytes(pwBytes,recoveredUserPw,fileKey);
    }
  }catch(e){
    return {notSimple:true};
  }
}
