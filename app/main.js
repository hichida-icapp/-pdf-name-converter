const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { loadIdNameMap } = require('../lib/csv');
// 検出ロジック（デリミタ優先 → 厳密数値 → 既存テキスト）
const {
  findTextBoxes,
  findNumberBoxExact,
  findDelimitedNumberBox,
} = require('../lib/extract');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('pick-dir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('pick-csv', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['openFile'],
  });
  return canceled ? null : filePaths[0];
});

function resolveFontPath() {
  const devPath = path.join(process.cwd(), 'assets', 'fonts', 'NotoSansJP-Regular.ttf');
  if (fs.existsSync(devPath)) return devPath;
  const prodPath = path.join(process.resourcesPath || '', 'fonts', 'NotoSansJP-Regular.ttf');
  return prodPath;
}

function resolveIdFromFilename(filename) {
  const stem = path.basename(filename, path.extname(filename));
  if (/^\d+$/.test(stem)) return stem;
  const m = stem.match(/\d{6,}/);
  if (m) return m[0];
  return null;
}

ipcMain.handle('convert-all', async (_evt, { inDir, csvPath, outDir }) => {
  const { map } = loadIdNameMap(csvPath);
  const inputFiles = fs.readdirSync(inDir).filter((f) => /\.pdf$/i.test(f));
  const outBase =
    outDir || path.join(inDir, `Output_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`);
  fs.mkdirSync(outBase, { recursive: true });

  const fontPath = resolveFontPath();
  const results = [];

  // 可変桁数（今回は 6 桁）。必要に応じて設定UIや環境変数で差し替え可
  const digitLength = 6;
  // デリミタ（今回の仕様：##674508##）
  const delimStart = '##';
  const delimEnd = '##';

  for (const f of inputFiles) {
    const inPath = path.join(inDir, f);

    // ファイル名からの暫定ID（なければ null）
    let fileId = resolveIdFromFilename(f);
    // CSVで名前を引くための変数
    let resolvedId = fileId;
    let name = resolvedId ? map.get(String(resolvedId)) : undefined;

    try {
      // 1) まず PDF 内のデリミタ付き「##...##」から可変桁の数字を抽出
      let box = await findDelimitedNumberBox(inPath, 0, delimStart, delimEnd, digitLength);
      if (box?.idText) {
        resolvedId = box.idText;
        name = map.get(String(resolvedId));
      }

      console.log('[detect] file:', f, 'box:', box);

      // 2) デリミタが無い、あるいは CSV にIDが無い場合はフォールバック
      if (!name && fileId) {
        // 数字のみの厳密検出（分割文字にも対応）
        const numBox = await findNumberBoxExact(inPath, String(fileId), 0);
        if (numBox) box = box || numBox;
        resolvedId = resolvedId || fileId;
        name = map.get(String(resolvedId));
      }

      // 3) まだ見つからなければ従来の「テキスト検索」の先頭ヒットを使う
      if ((!box || !name) && fileId) {
        const boxes = await findTextBoxes(inPath, String(fileId), 0);
        if (boxes && boxes.length) box = box || boxes[0];
        resolvedId = resolvedId || fileId;
        name = name || map.get(String(resolvedId));
      }

      if (!name) {
        results.push({ file: f, status: 'skipped', reason: 'CSVにIDが見つからない' });
        continue;
      }

      // maskAtBoxAndWrite は lib/pdf.js に定義
      const { maskAtBoxAndWrite } = require('../lib/pdf');

      let outPath;
      if (box) {
        console.log('[convert-all] using box:', box);
        outPath = await maskAtBoxAndWrite(inPath, outBase, name, box, fontPath);
        results.push({ file: f, status: 'ok', mode: 'mask-by-detect', outPath });
      } else {
        // 既定位置のフォールバック
        const fallback = { x: 400, y: 760, width: 150, height: 26, pageIndex: 0 };
        console.log('[convert-all] using box:', fallback, '(fallback)');
        outPath = await maskAtBoxAndWrite(inPath, outBase, name, fallback, fontPath);
        results.push({ file: f, status: 'ok', mode: 'mask-by-fallback', outPath });
      }

      console.log('[convert-all] wrote:', outPath);
    } catch (e) {
      results.push({ file: f, status: 'error', error: String(e) });
    }
  }

  return { outDir: outBase, count: results.length, results };
});