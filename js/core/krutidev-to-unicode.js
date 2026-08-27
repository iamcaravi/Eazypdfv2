/* ---------------- Kruti Dev (legacy non-Unicode Hindi encoding) -> Unicode Devanagari ----------------
   Kruti Dev is NOT a Unicode font: each "letter" you type maps to an arbitrary Latin-1/ASCII byte
   chosen to make that byte's built-in glyph LOOK like a Devanagari shape when displayed in the Kruti
   Dev font. The underlying character codes are ordinary Latin letters/punctuation - a program that
   doesn't have Kruti Dev's glyph table has no way to know "s" here means "े" and not the letter s.
   That's why copying Kruti Dev text out of Word (or, as here, drawing it with a real Unicode font)
   produces exactly the kind of garbled Latin-looking text this fix addresses ("Isok esa" instead of
   "सेवा में") - the bytes were never Devanagari to begin with.

   Getting the actual conversion right requires more than a per-character lookup table: Kruti Dev
   types some matras and conjuncts in VISUAL order (e.g. the "f" that becomes the short-i matra ि is
   typed BEFORE its consonant, since ि renders to the consonant's left), while Unicode requires
   storage in LOGICAL order (the matra character must follow its base consonant even though it still
   renders to the left of it). The reph (ऱ्, "Z" in Kruti Dev) has a similar relocation problem: it's
   typed where it visually sits but must be moved before its consonant cluster in Unicode. A flat
   find/replace table cannot get any of this right on its own - it needs the reordering passes below.

   Ported (not reimplemented from scratch/approximated) from the ISC-licensed
   @anthro-ai/krutidev-unicode package (https://www.npmjs.com/package/@anthro-ai/krutidev-unicode,
   https://unpkg.com/@anthro-ai/krutidev-unicode@0.1.0/) - a from-scratch implementation of the
   long-established community Kruti Dev glyph-mapping + reordering rules used across the Indian
   government/legal-tech ecosystem, not a hand-rolled approximation built from this session's own
   test documents. Its `replace-string` dependency (a plain non-regex global string replace) is
   inlined below as replaceAllLiteral() instead of pulling in another external script. The mutate-
   while-matching loop structure is kept exactly as published, since it's what the reordering passes
   depend on; only defensive iteration caps were added (this file's own addition) so a pathological
   input can't hang the conversion the way mammoth.extractRawText()/page.render() are already known
   to hang elsewhere in this codebase (see pdf-convert-tools.js) - never a change to the mapping
   logic itself. */

const KRUTIDEV_CONSONANTS = {
  krutidev: [
    "d", "[k", "x", "?k", "³", "p", "N", "t", ">", "¥",
    "V", "B", "M", "<", ".k", "r", "Fk", "n", "/k", "u",
    "u", "i", "Q", "c", "Hk", "e", ";", "j", "j", "y",
    "G", "ऴ", "o", "'k", "\"k", "l", "g", "d", "[k", "x",
    "t", "M+", "<+", "Q", ";",
    "D", "[", "X", "?", "³~", "P", "N~", "T", "÷", "¥~",
    "V~", "B~", "M~", "<~", ".", "R", "F", "n~", "/", "Ë",
    "è", "U", "I", "¶", "C", "H", "E", "¸", "Z", "Y",
    "O", "'", "Ü", "\"", "L", "º",
  ],
  unicode: [
    "क", "ख", "ग", "घ", "ङ", "च", "छ", "ज", "झ", "ञ",
    "ट", "ठ", "ड", "ढ", "ण", "त", "थ", "द", "ध", "न",
    "ऩ", "प", "फ", "ब", "भ", "म", "य", "र", "ऱ", "ल",
    "ळ", "ऴ", "व", "श", "ष", "स", "ह", "क़", "ख़", "ग़",
    "ज़", "ड़", "ढ़", "फ़", "य़",
  ],
};

const KRUTIDEV_UNATTACHED = {
  krutidev: ["k", "f", "h", "q", "w", "`", "s", "S", "ks", "kS", "a", "%", "¡", "W"],
  unicode: ["ा", "ि", "ी", "ु", "ू", "ृ", "े", "ै", "ो", "ौ", "ं", "ः", "ँ", "ॅ"],
};

const KRUTIDEV_VOWELS_UNICODE = [
  "अ", "आ", "इ", "ई", "उ", "ऊ", "ए", "ऐ", "ओ", "औ",
  "ा", "ि", "ी", "ु", "ू", "ृ", "े", "ै", "ो", "ौ",
  "ं", "ः", "ँ", "ॅ",
];

// Ordered [find, replace] pairs, applied in sequence - order matters (longer/more specific
// sequences are listed before the shorter ones they overlap with).
const KRUTIDEV_MAIN_TABLE = [
  ["ñ", "॰"], ["Q+Z", "QZ+"], ["sas", "sa"], ["aa", "a"], [")Z", "र्द्ध"],
  ["ZZ", "Z"], ["‘", "\""], ["’", "\""], ["“", "'"], ["”", "'"],
  ["å", "०"], ["ƒ", "१"], ["„", "२"], ["…", "३"], ["†", "४"],
  ["‡", "५"], ["ˆ", "६"], ["‰", "७"], ["Š", "८"], ["‹", "९"],
  ["¶+", "फ़्"], ["d+", "क़"], ["[+k", "ख़"], ["[+", "ख़्"], ["x+", "ग़"],
  ["T+", "ज़्"], ["t+", "ज़"], ["M+", "ड़"], ["<+", "ढ़"], ["Q+", "फ़"],
  [";+", "य़"], ["j+", "ऱ"], ["u+", "ऩ"], ["Ùk", "त्त"], ["Ù", "त्त्"],
  ["ä", "क्त"], ["–", "दृ"], ["—", "कृ"], ["é", "न्न"], ["™", "न्न्"],
  ["=kk", "=k"], ["f=k", "f="], ["à", "ह्न"], ["á", "ह्य"], ["â", "हृ"],
  ["ã", "ह्म"], ["ºz", "ह्र"], ["º", "ह्"], ["í", "द्द"], ["{k", "क्ष"],
  ["{", "क्ष्"], ["=", "त्र"], ["«", "त्र्"], ["Nî", "छ्य"], ["Vî", "ट्य"],
  ["Bî", "ठ्य"], ["Mî", "ड्य"], ["<î", "ढ्य"], ["|", "द्य"], ["K", "ज्ञ"],
  ["}", "द्व"], ["J", "श्र"], ["Vª", "ट्र"], ["Mª", "ड्र"], ["<ªª", "ढ्र"],
  ["Nª", "छ्र"], ["Ø", "क्र"], ["Ý", "फ्र"], ["nzZ", "र्द्र"], ["æ", "द्र"],
  ["ç", "प्र"], ["Á", "प्र"], ["xz", "ग्र"], ["#", "रु"], [":", "रू"],
  ["v‚", "ऑ"], ["vks", "ओ"], ["vkS", "औ"], ["vk", "आ"], ["v", "अ"],
  ["b±", "ईं"], ["Ã", "ई"], ["bZ", "ई"], ["b", "इ"], ["m", "उ"],
  ["Å", "ऊ"], [",s", "ऐ"], [",", "ए"], ["_", "ऋ"], ["ô", "क्क"],
  ["d", "क"], ["Dk", "क"], ["D", "क्"], ["[k", "ख"], ["[", "ख्"],
  ["x", "ग"], ["Xk", "ग"], ["X", "ग्"], ["Ä", "घ"], ["?k", "घ"],
  ["?", "घ्"], ["³", "ङ"], ["pkS", "चै"], ["p", "च"], ["Pk", "च"],
  ["P", "च्"], ["N", "छ"], ["t", "ज"], ["Tk", "ज"], ["T", "ज्"],
  [">", "झ"], ["÷", "झ्"], ["¥", "ञ"], ["ê", "ट्ट"], ["ë", "ट्ठ"],
  ["V", "ट"], ["B", "ठ"], ["ì", "ड्ड"], ["ï", "ड्ढ"], ["M+", "ड़"],
  ["<+", "ढ़"], ["M", "ड"], ["<", "ढ"], [".k", "ण"], [".", "ण्"],
  ["r", "त"], ["Rk", "त"], ["R", "त्"], ["Fk", "थ"], ["F", "थ्"],
  [")", "द्ध"], ["n", "द"], ["/k", "ध"], ["/", "ध्"], ["Ë", "ध्"],
  ["è", "ध"], ["u", "न"], ["Uk", "न"], ["U", "न्"], ["i", "प"],
  ["Ik", "प"], ["I", "प्"], ["Q", "फ"], ["¶", "फ्"], ["c", "ब"],
  ["Ck", "ब"], ["C", "ब्"], ["Hk", "भ"], ["H", "भ्"], ["e", "म"],
  ["Ek", "म"], ["E", "म्"], [";", "य"], ["¸", "य्"], ["j", "र"],
  ["y", "ल"], ["Yk", "ल"], ["Y", "ल्"], ["G", "ळ"], ["o", "व"],
  ["Ok", "व"], ["O", "व्"], ["'k", "श"], ["'", "श्"], ["\"k", "ष"],
  ["\"", "ष्"], ["l", "स"], ["Lk", "स"], ["L", "स्"], ["g", "ह"],
  ["È", "ीं"], ["saz", "्रें"], ["z", "्र"], ["Ì", "द्द"], ["Í", "ट्ट"],
  ["Î", "ट्ठ"], ["Ï", "ड्ड"], ["Ñ", "कृ"], ["Ò", "भ"], ["Ó", "्य"],
  ["Ô", "ड्ढ"], ["Ö", "झ्"], ["Ø", "क्र"], ["Ù", "त्त्"], ["Ük", "श"],
  ["Ü", "श्"], ["‚", "ॉ"], ["kas", "ों"], ["ks", "ो"], ["kS", "ौ"],
  ["¡k", "ाँ"], ["ak", "kं"], ["k", "ा"], ["ah", "ीं"], ["h", "ी"],
  ["aq", "ुं"], ["q", "ु"], ["aw", "ूं"], ["¡w", "ूँ"], ["w", "ू"],
  ["`", "ृ"], ["̀", "ृ"], ["as", "ें"], ["±s", "s±"], ["s", "े"],
  ["aS", "ैं"], ["S", "ै"], ["aª", "्रं"], ["ª", "्र"], ["fa", "ंf"],
  ["a", "ं"], ["¡", "ँ"], ["%", ":"], ["W", "ॅ"], ["•", "ऽ"],
  ["·", "ऽ"], ["∙", "ऽ"], ["·", "ऽ"], ["~j", "्र"], ["~", "्"],
  ["\\", "?"], ["+", "़"], ["^", "‘"], ["*", "’"], ["Þ", "“"],
  ["ß", "”"], ["(", ";"], ["¼", "("], ["½", ")"], ["À", "}"],
  ["¾", "="], ["A", "।"], ["-", "."], ["&", "-"], ["&", "µ"],
  ["μ", "-"], ["Œ", "॰"], ["]", ","], ["~ ", "् "], ["@", "/"],
  ["®", "ैं"],
];

function replaceAllLiteral(text, find, replace){
  return find === "" ? text : text.split(find).join(replace);
}

/* Common Kruti Dev family names as shipped/sold (010/011/016/017/019/020/040 are the most widely
   used weights/variants). Matched loosely (spacing/case-insensitive, optional trailing digits) so
   "KrutiDev010", "Kruti Dev 010", "kruti dev-010" and a bare "Kruti Dev" all match, but this must
   stay narrow enough to never match an unrelated font that merely mentions "Dev" (DevLys, Nirmala UI,
   Kalinga, ...) - those are different, non-Kruti-Dev legacy encodings this converter does not handle. */
const KRUTIDEV_FONT_NAME_RE = /^\s*kruti\s*-?\s*dev(\s*-?\s*\d+)?\s*$/i;

function isKrutiDevFontName(fontName){
  return !!fontName && KRUTIDEV_FONT_NAME_RE.test(String(fontName));
}

/**
 * Converts Kruti Dev-encoded text to Unicode Devanagari. Only call this on text whose FONT was
 * actually detected as Kruti Dev (isKrutiDevFontName) - running it on already-correct Unicode text,
 * or on a different legacy encoding, will corrupt it, since this table's "find" side is ordinary
 * Latin-range bytes that could coincidentally appear in other text.
 * @param {string} input
 * @returns {string}
 */
function krutidevToUnicode(input){
  let text = String(input);
  const MAX_ITER = 20000; // defensive cap only - see file header; never changes the mapping logic

  // space + ्र -> ्र  (and two other pre-typed-space artifacts)
  text = replaceAllLiteral(text, " ª", "ª");
  text = replaceAllLiteral(text, " ~j", "~j");
  text = replaceAllLiteral(text, " z", "z");

  // NOTE: the upstream library this is ported from has a matching "[ab] -> &" reclassification
  // pass here, guarded by `index < result.length - 1` where `result` is a regex-exec() match array
  // (always length 1 for a no-capture-group pattern) rather than the text being scanned - so that
  // condition is always false and the pass never actually executes in the published, tested library.
  // Deliberately omitted here rather than "fixed": porting the real (inert) runtime behavior, not a
  // corrected version the rest of the table was never tested against - implementing what the guard
  // literally does (text.length instead of result.length) was tried and verified WRONG here, since
  // it reclassifies common word-final anusvara ("a" before closing punctuation, as in "गोंडा।") as
  // Kruti Dev's dash glyph instead, corrupting otherwise-correct conversions.

  KRUTIDEV_MAIN_TABLE.forEach(([find, replace]) => { text = replaceAllLiteral(text, find, replace); });
  text = replaceAllLiteral(text, "±", "Zं");
  text = replaceAllLiteral(text, "Æ", "र्f");

  // f + ? -> ? + ि   (the pre-typed short-i matra moves to logical/after-consonant order)
  {
    const misplaced = /f(.?)/g;
    let result, guard = 0;
    while((result = misplaced.exec(text)) && guard++ < MAX_ITER){
      const match = result[1];
      text = text.replace("f" + match, match + "ि");
    }
  }
  text = replaceAllLiteral(text, "Ç", "fa");
  text = replaceAllLiteral(text, "¯", "fa");
  text = replaceAllLiteral(text, "É", "र्fa");

  // fa? -> ? + िं
  {
    const misplaced = /fa(.?)/g;
    let result, guard = 0;
    while((result = misplaced.exec(text)) && guard++ < MAX_ITER){
      const match = result[1];
      text = text.replace("fa" + match, match + "िं");
    }
  }
  text = replaceAllLiteral(text, "Ê", "ीZ");

  // ि् + ? -> ् + ? + ि
  {
    const misplaced = /ि्(.?)/g;
    let result, guard = 0;
    while((result = misplaced.exec(text)) && guard++ < MAX_ITER){
      const match = result[1];
      text = text.replace("ि्" + match, "्" + match + "ि");
    }
  }
  text = replaceAllLiteral(text, "्Z", "Z");

  // र + ् (encoded as a trailing "Z") has to move before its whole consonant/matra cluster, not sit
  // where it was typed - walk left over any matras already attached to find the real insertion point.
  {
    const misplaced = /(.?)Z/g;
    let result, guard = 0;
    while((result = misplaced.exec(text)) && guard++ < MAX_ITER){
      let match = result[1];
      let index = text.indexOf(match + "Z");
      while(index >= 0 && KRUTIDEV_VOWELS_UNICODE.includes(text[index])){
        index -= 1;
        match = text[index] + match;
      }
      text = text.replace(match + "Z", "र्" + match);
    }
  }

  // ' ', ',' and ् are illegal immediately before a matra - clean those up.
  KRUTIDEV_UNATTACHED.unicode.forEach((matra) => {
    text = replaceAllLiteral(text, " " + matra, matra);
    text = replaceAllLiteral(text, "," + matra, matra + ",");
    text = replaceAllLiteral(text, "्" + matra, matra + ",");
  });
  text = replaceAllLiteral(text, "््र", "्र");
  text = replaceAllLiteral(text, "्र्", "र्");
  text = replaceAllLiteral(text, "््", "्");

  // A halant as the very last character of a word is illegal.
  text = replaceAllLiteral(text, "् ", " ");

  return text.trim();
}
