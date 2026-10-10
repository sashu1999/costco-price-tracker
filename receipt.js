// Reads a Costco in-warehouse receipt PDF (from "Print Receipt" → Save as PDF).
// Uses pdf.js (window.pdfjsLib) to get the text, then parses item lines.

// Rebuild text lines from pdf.js text items by grouping on the y coordinate.
async function pdfToLines(file) {
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const lines = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const { items } = await page.getTextContent();
    const rows = [];
    for (const it of items) {
      if (!it.str.trim()) continue;
      const x = it.transform[4], y = it.transform[5];
      let row = rows.find(r => Math.abs(r.y - y) < 2.5);
      if (!row) rows.push(row = { y, parts: [] });
      row.parts.push({ x, s: it.str.trim() });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) lines.push(r.parts.sort((a, b) => a.x - b.x).map(p => p.s).join(" ").replace(/\s+/g, " ").trim());
  }
  return lines;
}

const ITEM_RE = /^(?:E\s+)?(\d{3,8})\s+(.*?)\s*(\d+\.\d{2})\s*(?:[A-Z0-9])?$/;      // "E 1978643 RANA CKN KIT 12.99 3"
const DISCOUNT_RE = /^(?:E\s+)?(\d{3,8})\s*\/\s*(\d{3,8})\s+(\d+\.\d{2})-/;      // "388186 / 1600575 3.00-"
const STOP_RE = /^(SUBTOTAL|TAX|\*+\s*TOTAL|TOTAL)\b/;
const NOT_NAME_RE = /\d|^(Member|SUBTOTAL|TAX|TOTAL)\b/i;

// Turn receipt lines into { date, warehouse, items: [{ item, name, paid, discount }] }.
function parseReceipt(lines) {
  const out = { date: null, warehouse: null, items: [] };
  for (const l of lines) {
    const d = l.match(/(\d{2})\/(\d{2})\/(\d{4}) \d{2}:\d{2} (\d+)/);
    if (d && !out.date) { out.date = `${d[3]}-${d[1]}-${d[2]}`; out.warehouse = d[4]; }
    const w = l.match(/Whse:\s*(\d+)/);
    if (w) out.warehouse = w[1];
  }
  if (!out.warehouse) {
    const head = lines.slice(0, 3).join(" ").match(/#(\d+)/);
    if (head) out.warehouse = head[1];
  }

  const start = lines.findIndex(l => /^Member\b/i.test(l));
  let pendingName = "";        // a name line printed above an item whose name wrapped
  let needsTail = null;        // item still waiting for the rest of its wrapped name
  for (let i = start < 0 ? 0 : start + 2; i < lines.length; i++) {
    const l = lines[i];
    if (STOP_RE.test(l)) break;
    const disc = l.match(DISCOUNT_RE);
    if (disc) {
      const target = [...out.items].reverse().find(it => it.item === disc[2]);
      if (target) { target.discount = +(target.discount + parseFloat(disc[3])).toFixed(2); target.paid = +(target.price - target.discount).toFixed(2); }
      pendingName = ""; needsTail = null;
      continue;
    }
    const m = l.match(ITEM_RE);
    if (m) {
      const name = m[2].trim();
      const entry = { item: m[1], name: name || pendingName, price: parseFloat(m[3]), discount: 0, paid: parseFloat(m[3]) };
      needsTail = name ? null : entry;
      pendingName = "";
      out.items.push(entry);
      continue;
    }
    if (!NOT_NAME_RE.test(l)) {
      if (needsTail) { needsTail.name = `${needsTail.name} ${l}`.trim(); needsTail = null; }
      else pendingName = `${pendingName} ${l}`.trim();
    }
  }
  return out;
}

window.readCostcoReceipt = async file => parseReceipt(await pdfToLines(file));
window.parseCostcoReceiptLines = parseReceipt;
