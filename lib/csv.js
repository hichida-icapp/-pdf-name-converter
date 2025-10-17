const fs = require('fs');
const chardet = require('chardet');
const iconv = require('iconv-lite');

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const headers = lines.shift().split(',').map(s => s.trim().replace(/^\uFEFF/, ''));
  const rows = lines.map(line => {
    const cols = line.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (cols[i] || '').trim(); });
    return obj;
  });
  return { headers, rows };
}

exports.loadIdNameMap = function loadIdNameMap(csvPath) {
  const buf = fs.readFileSync(csvPath);
  const enc = chardet.detect(buf) || 'UTF-8';
  const text = iconv.decode(buf, enc);
  const { headers, rows } = parseCSV(text);

  if (!headers.includes('id') || !headers.includes('name')) {
    throw new Error('CSVヘッダーは id,name を含む必要があります');
  }

  const map = new Map();
  for (const r of rows) {
    if (r.id) map.set(String(r.id), r.name || '');
  }
  return { enc, headers, rows, map };
};