const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

function sanitizeFileName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

async function embedJPFont(pdf, fontPath) {
  pdf.registerFontkit(fontkit);
  if (!fontPath || !fs.existsSync(fontPath)) {
    throw new Error('日本語フォント(TTF)が見つかりません: ' + fontPath);
  }
  const fontBytes = fs.readFileSync(fontPath);
  // ここを subset: false に
  return await pdf.embedFont(fontBytes, { subset: false });
}

exports.maskAtBoxAndWrite = async function maskAtBoxAndWrite(
  inFilePath,
  outDir,
  displayName,
  box,
  fontPath
) {
  const bytes = fs.readFileSync(inFilePath);
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await embedJPFont(pdf, fontPath);
  const p = pdf.getPages()[box.pageIndex || 0];

  // --- 左上基準に変換して描画する ---
  // pdfjs の box.x, box.y は「ベースライン左端」相当（左下基準）
  // 左上を原点に扱いたいので、topY = y + height を計算
  const bx = box.x || 0;
  const bh = box.height || 24;
  const bw = box.width || 140;
  const topY = (box.y || 0) + bh; // 左上Y

  // マスクのパディング
  const padX = 10; // 左右合計12pt相当
  const padY = 0; // 上下合計8pt相当

  const maskW = bw + padX * 2;
  const maskH = bh + padY * 2;
  const leftX = bx - padX;                  // 左上基準のX（左に広げる）
  const rectY = (topY + padY) - maskH - 2 ;      // 下端Y（左下基準へ変換）



  console.log('[mask] rect (final white):', {
    x: leftX, y: rectY, width: maskW, height: maskH
  });

  // 1) 白マスク（左上基準の拡張パディングで覆う）
  p.drawRectangle({
    x: leftX,
    y: rectY,
    width: maskW,
    height: maskH,
    color: rgb(1, 1, 1),
  });

  // 2) 氏名を左上基準で配置
  const h = Math.max(10, bh);
  //const textSize = Math.max(14, h * 1.8);
  const textSize = 8 ;
  // マスク上端から少し下げた位置にベースラインを置く
  const maskTopY = rectY + maskH;
  //const baseline = maskTopY - Math.min(textSize * 0.85, maskH - 4);
  const baseline = maskTopY -9

  p.drawText(displayName, {
    x: leftX,
    y: baseline,
    size: textSize,
    font,
    color: rgb(0,0,0),
  });

  const outName = sanitizeFileName(`${displayName}.pdf`);
  const outPath = path.join(outDir, outName);
  const outBytes = await pdf.save();
  fs.writeFileSync(outPath, outBytes);
  return outPath;
};