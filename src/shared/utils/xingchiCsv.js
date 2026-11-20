/** CSV import for the Xingchi onboarding extension. Passwords and session tokens
 * are intentionally discarded; the browser bridge pairs sessions separately. */
function parseCells(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      cells.push(current.trim()); current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function splitLines(csv) {
  const rows = [];
  let buffer = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      if (quoted && csv[i + 1] === '"') { buffer += '""'; i++; }
      else { quoted = !quoted; buffer += ch; }
    } else if ((ch === "\r" || ch === "\n") && !quoted) {
      if (buffer.trim()) rows.push(buffer);
      buffer = "";
      if (ch === "\r" && csv[i + 1] === "\n") i++;
    } else buffer += ch;
  }
  if (buffer.trim()) rows.push(buffer);
  return rows;
}

export function parseXingchiCsv(text) {
  const rows = splitLines(String(text || "").replace(/^\ufeff/, ""));
  if (rows.length === 0) return [];
  const columns = parseCells(rows[0]).map((h) => h.toLowerCase().replace(/[\s-]/g, "_"));
  const emailCol = columns.indexOf("email");
  if (emailCol === -1) throw new Error("CSV must include an email column.");
  const keyCol = columns.indexOf("api_key");
  const nameCol = columns.indexOf("name");
  const keyNameCol = columns.indexOf("key_name");
  const seen = new Set();
  const items = [];
  for (const line of rows.slice(1)) {
    const cells = parseCells(line);
    const email = (cells[emailCol] || "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error(`Invalid CSV email on row ${items.length + 2}.`);
    seen.add(email);
    items.push({ email, name: (cells[nameCol] || cells[keyNameCol] || email).trim() || email,
      apiKey: (cells[keyCol] || "").trim() });
  }
  return items;
}
