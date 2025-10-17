const log = (m) => (document.getElementById('log').textContent += m + "\n");

let inDir = '', csvPath = '', outDir = '';

document.getElementById('pick-in').onclick = async () => {
  inDir = await window.api.pickDir();
  document.getElementById('inDir').textContent = inDir || '';
};

document.getElementById('pick-csv').onclick = async () => {
  csvPath = await window.api.pickCSV();
  document.getElementById('csvPath').textContent = csvPath || '';
};

document.getElementById('pick-out').onclick = async () => {
  outDir = await window.api.pickDir();
  document.getElementById('outDir').textContent = outDir || '';
};

document.getElementById('start').onclick = async () => {
  if (!inDir || !csvPath) {
    log('入力フォルダとCSVを選択してください');
    return;
  }
  log('変換を開始します…');
  const res = await window.api.convertAll({ inDir, csvPath, outDir });
  log(JSON.stringify(res, null, 2));
  log('完了');
};