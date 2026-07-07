// sync.mjs — тянет данные с Confluence и пишет data/methods.json

import { writeFile, readFile } from "node:fs/promises";

const BASE   = (process.env.CONF_BASE || "https://pokerplanets.atlassian.net/wiki").replace(/\/+$/, "");
const EMAIL  = process.env.CONF_EMAIL;
const TOKEN  = process.env.CONF_TOKEN;
const PAGE_ID= process.env.PAGE_ID    || "75333720";
const OUT     = "data/methods.json";

// --- диагностика окружения (без раскрытия секретов) ---
function skeleton(s) {
  if (!s) return "(пусто!)";
  // показываем схему и домен, всё остальное скрываем
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.hostname}${u.pathname}`;
  } catch {
    return `(не-URL, длина ${s.length})`;
  }
}
console.log("=== ДИАГНОСТИКА ===");
console.log("CONF_BASE задан:", !!process.env.CONF_BASE, "| скелет:", skeleton(process.env.CONF_BASE));
console.log("CONF_EMAIL задан:", !!EMAIL, "| длина:", (EMAIL || "").length, "| содержит @:", (EMAIL || "").includes("@"));
console.log("CONF_TOKEN задан:", !!TOKEN, "| длина:", (TOKEN || "").length);
console.log("PAGE_ID:", PAGE_ID);
console.log("===================");

const STATIC = {
  generalWithdrawalLimits: { perDay: 3000, perWeek: 10000, perMonth: 25000 },
  firstDepositLabels: {
    yes: "Доступен для первого депозита",
    no: "Только после депозита",
    conditional: "Зависит от группы игрока",
    twoDeposits: "После двух депозитов",
    withdrawal: "Только вывод",
  },
};

const money = s => {
  s = (s || "").trim();
  if (s === "" || s === "-" || s === "—") return null;
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? null : n;
};

function detectFd(t) {
  t = (t || "").toLowerCase();
  if (/two|least two|2 deposit|два/.test(t)) return "twoDeposits";
  const sochi = t.includes("sochi");
  const once  = /at least one|made at least|repeat|повтор/.test(t);
  if (sochi && once) return "conditional";
  if (once) return "no";
  if (sochi) return "conditional";
  return "yes";
}

function textOf(node, acc = []) {
  if (!node) return acc;
  if (Array.isArray(node)) { node.forEach(n => textOf(n, acc)); return acc; }
  if (typeof node === "object") {
    if (node.type === "text" && node.text) acc.push(node.text);
    if (node.content) textOf(node.content, acc);
  }
  return acc;
}

const cellText = c => textOf(c).join(" ").replace(/\s+/g, " ").trim();

function rowToMethod(cells) {
  const [provider, type, name, , firstDep, minD, maxD, minW, maxW] = cells;
  const method = (name || "").replace(/!\[\]\([^)]*\)/g, "").trim();
  if (!provider || !method) return null;
  const obj = { method, type: type || "", provider };
  const d1 = money(minD), d2 = money(maxD), w1 = money(minW), w2 = money(maxW);
  if (/withdrawal/i.test(type || "")) {
    if (w1 != null) obj.minW = w1;
    if (w2 != null) obj.maxW = w2;
    obj._withdrawalOnly = true;
  } else {
    obj.minD = d1; obj.maxD = d2;
    if (w1 != null) obj.minW = w1;
    if (w2 != null) obj.maxW = w2;
    obj.fd = detectFd(firstDep);
  }
  return obj;
}

function findParagraphs(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach(n => findParagraphs(n, out)); return out; }
  if (typeof node === "object") {
    if (node.type === "paragraph") out.push(textOf(node).join(" ").replace(/\s+/g, " ").trim());
    if (node.content) findParagraphs(node.content, out);
  }
  return out;
}

function parseCountryList(paragraphs) {
  let best = "";
  for (const p of paragraphs) {
    const body = p.includes(":") ? p.slice(p.indexOf(":") + 1) : p;
    if (body.split(",").length > best.split(",").length) best = body;
  }
  return best.split(",").map(s => s.trim()).filter(s => s && !/^https?:/i.test(s) && s.length < 40);
}

function findTables(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach(n => findTables(n, out)); return out; }
  if (typeof node === "object") {
    if (node.type === "table") {
      const rows = (node.content || []).map(r => (r.content || []).map(cellText));
      out.push(rows);
    }
    if (node.content) findTables(node.content, out);
  }
  return out;
}

// ---------- получение страницы: пробуем v2, при 404 — v1 ----------
const auth = "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
const headers = { Authorization: auth, Accept: "application/json" };

async function tryFetch(url) {
  const res = await fetch(url, { headers });
  return res;
}

let doc, version, updatedAt;

// попытка 1: REST API v2
const urlV2 = `${BASE}/api/v2/pages/${PAGE_ID}?body-format=atlas_doc_format`;
let res = await tryFetch(urlV2);

if (res.status === 404) {
  console.warn("v2 вернул 404, пробую v1 endpoint...");
  // попытка 2: REST API v1
  const urlV1 = `${BASE}/rest/api/content/${PAGE_ID}?expand=body.atlas_doc_format,version`;
  res = await tryFetch(urlV1);
  if (res.ok) {
    const page = await res.json();
    version = page.version?.number ?? null;
    updatedAt = (page.version?.when || page.version?.createdAt || "").slice(0, 10);
    doc = JSON.parse(page.body.atlas_doc_format.value);
  }
}

if (!doc) {
  if (!res.ok) {
    console.error(`Не удалось получить страницу. Последний статус: ${res.status}`);
    console.error(await res.text());
    process.exit(1);
  }
  // v2 успех
  const page = await res.json();
  version = page.version?.number ?? null;
  updatedAt = (page.version?.createdAt || "").slice(0, 10);
  doc = JSON.parse(page.body.atlas_doc_format.value);
}

// ---------- разбор ----------
const local = {};
let general = { currency: "USD", symbol: "$", methods: [] };
let generalCountries = [];
let generalFound = false;

for (const node of doc.content || []) {
  if (node.type !== "expand") continue;
  const title = (node.attrs?.title || "").trim();
  if (!title) continue;
  const tables = findTables(node);
  if (!tables.length) continue;

  const rawBlob = JSON.stringify(tables);
  let currency = "USD", symbol = "$";
  if (rawBlob.includes("₹")) { currency = "INR"; symbol = "₹"; }
  else if (rawBlob.includes("€")) { currency = "EUR"; symbol = "€"; }

  const deposits = [], withdrawals = [];
  for (const table of tables) {
    for (const cells of table) {
      if (/provider/i.test(cells[0] || "")) continue;
      const m = rowToMethod(cells);
      if (!m) continue;
      if (m._withdrawalOnly) { delete m._withdrawalOnly; withdrawals.push(m); }
      else deposits.push(m);
    }
  }

  if (/general|international/i.test(title)) {
    generalFound = true;
    general = { currency, symbol, methods: deposits };
    generalCountries = parseCountryList(findParagraphs(node));
    continue;
  }

  const key = title.charAt(0) + title.slice(1).toLowerCase();
  local[key] = { currency, symbol, deposits, withdrawals };
}

if (!generalFound) {
  try {
    const prev = JSON.parse(await readFile(OUT, "utf-8"));
    general = prev.general || general;
    generalCountries = prev.generalCountries || [];
    console.warn("GENERAL / INTERNATIONAL экспанд не найден — general взят из существующего methods.json.");
  } catch {}
}

const out = {
  local, general, generalCountries,
  generalWithdrawalLimits: STATIC.generalWithdrawalLimits,
  firstDepositLabels: STATIC.firstDepositLabels,
  _meta: {
    source: "Cashier Operations: PSP Deposits, Withdrawals & Limits (page " + PAGE_ID + ")",
    sourcePageId: PAGE_ID,
    sourceVersion: version,
    lastSynced: updatedAt,
  },
};

await writeFile(OUT, JSON.stringify(out, null, 2) + "\n", "utf-8");
console.log(`OK: страница v${version}, стран ${Object.keys(local).length}, general-методов ${general.methods.length}, стран general ${generalCountries.length}`);
