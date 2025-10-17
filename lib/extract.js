// lib/extract.js
const fs = require('fs');
const { pathToFileURL } = require('url');

// ---- DOMMatrix polyfill (pdfjs v4 を Node で使う際に必要なことがある) ----
try {
  if (typeof global.DOMMatrix === 'undefined') {
    const { DOMMatrix } = require('canvas');
    if (DOMMatrix) global.DOMMatrix = DOMMatrix;
  }
} catch (_) {
  // canvas が未導入でも動く場合はそのまま。必要なら `npm install canvas`
}

// ---- pdfjs-dist v4 ESM を CJS から動的 import ----
let cachedPdfjs = null;
async function getPdfjs() {
  if (cachedPdfjs) return cachedPdfjs;
  // v4 の ESM ビルド
  const pdfjsLib = await import('pdfjs-dist/build/pdf.mjs');
  // Worker の URL を file:// で指定
  const workerHref = pathToFileURL(require.resolve('pdfjs-dist/build/pdf.worker.mjs')).href;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerHref;
  cachedPdfjs = pdfjsLib;
  return pdfjsLib;
}

// ---- 汎用ヘルパ ----
function toDeviceSpace(transform, x, y) {
  // transform = [a, b, c, d, e, f]
  const [a, b, c, d, e, f] = transform;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

// ============================================================================
// 1) ゆるい包含検索（フォールバック用）
//    例: needle を含む item をそのまま 1ボックス扱いで返す
// ============================================================================
exports.findTextBoxes = async function findTextBoxes(pdfPath, needle, pageIndex = 0) {
  const pdfjsLib = await getPdfjs();
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const page = await doc.getPage(pageIndex + 1);
  const content = await page.getTextContent();

  const hits = [];
  for (const item of content.items) {
    const text = item.str || '';
    if (!text) continue;
    if (String(text).includes(String(needle))) {
      const t = item.transform;
      const { x, y } = toDeviceSpace(t, 0, 0);
      const fontSize = Math.hypot(t[2], t[3]) || 12;
      const width = item.width || (fontSize * text.length * 0.6);
      const height = fontSize * 1.2;
      hits.push({ text, x, y, width, height, fontSize, pageIndex });
    }
  }
  return hits;
};

// ============================================================================
// 2) 連続数字の厳密検出（数字アイテム連結）
//    例: needle = "674508" を 6→7→4→5→0→8 と連続する item として結合
//    近接(同一行/隣接)を簡易ルールで判定し 1 ボックスにまとめる
// ============================================================================
exports.findNumberBoxExact = async function findNumberBoxExact(pdfPath, needle, pageIndex = 0) {
  const pdfjsLib = await getPdfjs();
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const page = await doc.getPage(pageIndex + 1);
  const content = await page.getTextContent();

  const digits = String(needle).split('');
  // 数字アイテムのみ抽出（1文字単位 or 数文字単位のどちらでも対応）
  const items = content.items
    .filter((it) => /[0-9]/.test(it.str))
    .map((it) => ({ str: it.str, t: it.transform, width: it.width || 0 }));

  // 先頭位置をずらしながら needle と完全一致する run を探索
  for (let i = 0; i <= items.length - digits.length; i++) {
    let ok = true;
    const run = [];
    for (let k = 0; k < digits.length; k++) {
      const it = items[i + k];
      if ((it.str || '') !== digits[k]) {
        ok = false;
        break;
      }
      run.push(it);
    }
    if (!ok) continue;

    // 連続性チェック（同一行＆X方向でゆるく隣接）
    let contiguous = true;
    for (let k = 0; k < run.length - 1; k++) {
      const a = run[k],
        b = run[k + 1];
      const A = toDeviceSpace(a.t, 0, 0);
      const B = toDeviceSpace(b.t, 0, 0);
      const dy = Math.abs(A.y - B.y);
      if (dy > 2.0) {
        contiguous = false;
        break;
      }
      const axRight = A.x + (a.width || 0);
      if (B.x < axRight - 1 || B.x > axRight + 8) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;

    // ボックス化（先頭アイテム左下と末尾アイテム右端から）
    const first = run[0],
      last = run[run.length - 1];
    const F = toDeviceSpace(first.t, 0, 0);
    const Lleft = toDeviceSpace(last.t, 0, 0);
    const rightX = Lleft.x + (last.width || 0);

    const hApprox = Math.max(8, Math.hypot(first.t[2], first.t[3]) * 1.2);
    const wApprox = Math.max(8, rightX - F.x);
    return { text: String(needle), x: F.x, y: F.y, width: wApprox, height: hApprox, pageIndex };
  }
  return null;
};

// ============================================================================
// 3) デリミタ内の可変桁数字を検出（今回 digitLength=6 を想定）
//    例: "##674508##" の start="##", end="##", digitLength=6 で 674508 を抽出
//    文字が item 分割されていても、全文連結→インデックス対応で座標復元
// ============================================================================
exports.findDelimitedNumberBox = async function findDelimitedNumberBox(
  pdfPath,
  pageIndex = 0,
  start = '##',
  end = '##',
  digitLength = 6
) {
  const pdfjsLib = await getPdfjs();
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data }).promise;
  const page = await doc.getPage(pageIndex + 1);
  const content = await page.getTextContent();

  // item ごとの文字列をフラット化し、各文字→item の対応表を作る
  const items = content.items.map((it) => ({
    str: it.str || '',
    t: it.transform,
    width: it.width || 0,
  }));

  let full = '';
  const idxMap = []; // full の各文字 → { item, off } で逆引き
  items.forEach((it, idx) => {
    for (let k = 0; k < it.str.length; k++) idxMap.push({ item: idx, off: k });
    full += it.str;
  });

  const sPos = full.indexOf(start);
  if (sPos < 0) return null;
  const ePos = full.indexOf(end, sPos + start.length);
  if (ePos < 0) return null;

  const inner = full.slice(sPos + start.length, ePos).trim();
  const reDigits = new RegExp(`^\\d{${digitLength}}$`); // 可変桁数の数字のみ
  if (!reDigits.test(inner)) return null;

  // 先頭・末尾の item からボックス化
  const firstChar = idxMap[sPos + start.length];
  const lastCharEnd = idxMap[ePos - 1]; // 最後の数字の属する item
  const itFirst = items[firstChar.item];
  const itLast = items[lastCharEnd.item];

  const F = toDeviceSpace(itFirst.t, 0, 0); // 先頭左下
  const Lleft = toDeviceSpace(itLast.t, 0, 0);
  const rightX = Lleft.x + itLast.width;

  const hApprox = Math.max(10, Math.hypot(itFirst.t[2], itFirst.t[3]) * 1.2);
  const wApprox = Math.max(8, rightX - F.x);

  return { idText: inner, x: F.x, y: F.y, width: wApprox, height: hApprox, pageIndex };
};