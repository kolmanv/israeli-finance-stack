#!/usr/bin/env node
// card-bills: turn credit-card bill lines in bank accounts into Actual transfers
// to the right card account. Deterministic: matches each bill line by the bank's
// reference number (when it embeds the card number) or by summing the card's
// charges for that billing date from moneyman's JSON output.
//
// Usage: node index.mjs [--config config.json] [--apply] [--since YYYY-MM-DD]
// Dry-run unless --apply is given.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as api from "@actual-app/api";

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const APPLY = args.includes("--apply");
const here = path.dirname(new URL(import.meta.url).pathname);
const cfg = JSON.parse(fs.readFileSync(arg("--config", path.join(here, "config.json")), "utf8"));
const amountTol = cfg.amountTolerance ?? 1;
const dayTol = cfg.dayTolerance ?? 3;
const maxCombo = cfg.maxCombo ?? 4;
const since = arg("--since", new Date(Date.now() - (cfg.lookbackDays ?? 60) * 864e5).toISOString().slice(0, 10));

// ---- Actual connection: env vars, else ~/.actualrc.json (same as @actual-app/cli)
let conn = {};
const rc = path.join(os.homedir(), ".actualrc.json");
if (fs.existsSync(rc)) conn = JSON.parse(fs.readFileSync(rc, "utf8"));
const serverURL = process.env.ACTUAL_SERVER_URL ?? conn.serverUrl;
const password = process.env.ACTUAL_PASSWORD ?? conn.password;
const syncId = process.env.ACTUAL_SYNC_ID ?? conn.syncId;
if (!serverURL || !password || !syncId) throw new Error("Actual connection missing (ACTUAL_* env vars or ~/.actualrc.json)");

// ---- helpers
const ilDate = (iso) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Jerusalem" });
const days = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 864e5);
const fmt = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---- moneyman output: card totals per billing date, and bank lines with their reference numbers
const raw = new Map();
for (const f of fs.readdirSync(cfg.moneymanOutputDir).filter((f) => f.endsWith(".json"))) {
  for (const t of JSON.parse(fs.readFileSync(path.join(cfg.moneymanOutputDir, f), "utf8"))) {
    const key = [t.companyId, t.account, t.identifier ?? "", t.date, t.chargedAmount, t.description].join("|");
    raw.set(key, t);
  }
}
const cardTotals = new Map(); // `${company}|${card}|${billingDate}` -> ILS
const cardCharges = []; // individual completed card charges with their billing date
const bankRefs = new Map(); // `${company}|${utcDate}|${amount}|${desc}` -> identifier
for (const t of raw.values()) {
  if (t.chargedAmount == null) continue;
  if (t.status === "completed" && t.processedDate) {
    const d = ilDate(t.processedDate);
    const k = `${t.companyId}|${t.account}|${d}`;
    cardTotals.set(k, (cardTotals.get(k) ?? 0) + t.chargedAmount);
    cardCharges.push({ company: t.companyId, card: t.account, d, amount: t.chargedAmount, desc: t.description ?? "", memo: t.memo ?? "" });
  }
  if (t.identifier != null) bankRefs.set(`${t.companyId}|${t.date.slice(0, 10)}|${t.chargedAmount.toFixed(2)}|${t.description.trim()}`, String(t.identifier));
}

function matchBySum(bill, cards, date, amount) {
  const near = [];
  for (const card of Object.keys(cards)) {
    for (const [k, total] of cardTotals) {
      const [co, c, d] = k.split("|");
      if (co === bill.cardCompanyId && c === card && days(d, date) <= dayTol) near.push({ card, d, total });
    }
  }
  const single = near.filter((n) => Math.abs(n.total - amount) <= amountTol);
  if (single.length === 1) return { card: single[0].card, how: "sum", detail: `charges billed ${single[0].d}` };
  if (single.length > 1) return { how: "ambiguous", detail: single.map((s) => s.card).join("/") };
  // one bank line per card charge (e.g. several ATM withdrawals billed on the same day)
  const charges = cardCharges.filter(
    (c) => c.company === bill.cardCompanyId && cards[c.card] && days(c.d, date) <= dayTol && Math.abs(c.amount - amount) <= amountTol,
  );
  const chargeCards = [...new Set(charges.map((c) => c.card))];
  if (chargeCards.length === 1) return { card: chargeCards[0], how: "charge", detail: `${charges[0].desc} ${charges[0].memo}`.trim() };
  for (let r = 2; r <= Math.min(maxCombo, near.length); r++) {
    const combos = (arr, k, start = 0, acc = []) =>
      k === 0 ? [acc] : arr.slice(start).flatMap((x, i) => combos(arr, k - 1, start + i + 1, [...acc, x]));
    for (const c of combos(near, r)) {
      const cs = new Set(c.map((x) => x.card));
      if (cs.size === c.length && Math.abs(c.reduce((s, x) => s + x.total, 0) - amount) <= amountTol)
        return { how: "combined", detail: c.map((x) => x.card).join("+") };
    }
  }
  return { how: "unmatched", detail: near.length ? `closest: ${near.map((n) => `${n.card} ${fmt(n.total)}`).slice(0, 3).join(", ")}` : "no card charges near this date" };
}

// ---- Actual
fs.mkdirSync(path.join(here, ".actual-cache"), { recursive: true });
await api.init({ dataDir: path.join(here, ".actual-cache"), serverURL, password });
await api.downloadBudget(syncId);
const accounts = await api.getAccounts();
const accId = (name) => {
  const a = accounts.find((x) => x.name === name);
  if (!a) throw new Error(`Actual account not found: ${name}`);
  return a.id;
};
const payees = await api.getPayees();
const transferPayee = (accountId) => payees.find((p) => p.transfer_acct === accountId)?.id;

const results = [];
for (const bill of cfg.bills) {
  const bankId = accId(bill.bankAccount);
  const re = new RegExp(bill.payeePattern);
  const cards = bill.cards;
  const txns = (await api.getTransactions(bankId, since, "2100-01-01")).filter(
    (t) => !t.transfer_id && !t.is_parent && re.test(t.imported_payee ?? ""),
  );
  for (const t of txns) {
    const amount = t.amount / 100;
    let m;
    const ref = bankRefs.get(`${bill.bankCompanyId}|${t.date}|${amount.toFixed(2)}|${(t.imported_payee ?? "").trim()}`);
    const byRef = bill.referenceEndsWithCard && ref ? Object.keys(cards).find((c) => ref.endsWith(c)) : undefined;
    if (byRef) m = { card: byRef, how: "reference", detail: `ref ${ref}` };
    else if (Object.keys(cards).length === 1) m = { card: Object.keys(cards)[0], how: "only card", detail: "" };
    else m = matchBySum(bill, cards, t.date, amount);
    results.push({ t, bill, amount, ...m });
  }
}

// ---- report + apply
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function linked(accountId, id, date) {
  // Actual creates the card-side transaction asynchronously; wait until the link exists
  for (let i = 0; i < 20; i++) {
    const t = (await api.getTransactions(accountId, date, date)).find((x) => x.id === id);
    if (t?.transfer_id) return true;
    await sleep(250);
  }
  return false;
}
let applied = 0;
const failed = [];
console.log(`card-bills ${APPLY ? "APPLY" : "DRY-RUN"} since ${since}: ${results.length} bill lines\n`);
for (const r of results.sort((a, b) => a.t.date.localeCompare(b.t.date))) {
  const target = r.card ? r.bill.cards[r.card] : null;
  console.log(
    `${r.t.date}  ${r.bill.bankAccount.padEnd(9)} ${fmt(r.amount).padStart(11)}  ${r.how.padEnd(9)} ${target ? "-> " + target : ""}  ${r.detail}`,
  );
  if (APPLY && target) {
    const tp = transferPayee(accId(target));
    if (!tp) { failed.push(`${r.t.date} ${fmt(r.amount)}: no transfer payee for ${target}`); continue; }
    const note = `card ${r.card} bill ${r.t.date.slice(0, 7)} #card-bill`;
    const notes = r.t.notes?.includes("#card-bill") ? r.t.notes : r.t.notes ? `${r.t.notes} · ${note}` : note;
    // Actual applies updates asynchronously: pause between changes and verify the link, retrying a few times.
    // A line left half-done (transfer payee set, no link) needs a real payee change to re-trigger the transfer.
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      const cur = (await api.getTransactions(r.t.account, r.t.date, r.t.date)).find((x) => x.id === r.t.id);
      if (cur?.transfer_id) { ok = true; break; }
      if (cur?.payee === tp) { await api.updateTransaction(r.t.id, { payee: null }); await sleep(500); }
      await api.updateTransaction(r.t.id, { payee: tp, category: null, notes });
      await sleep(500);
      ok = await linked(r.t.account, r.t.id, r.t.date);
    }
    if (ok) applied++;
    else failed.push(`${r.t.date} ${r.bill.bankAccount} ${fmt(r.amount)} -> ${target}: transfer not created`);
  }
}
const by = results.reduce((m, r) => ((m[r.how] = (m[r.how] ?? 0) + 1), m), {});
console.log(`\nsummary: ${JSON.stringify(by)}${APPLY ? `, applied ${applied}, failed ${failed.length}` : " (dry-run, nothing changed)"}`);
for (const f of failed) console.log(`FAILED ${f}`);
if (APPLY) {
  await sleep(2000);
  await api.sync();
}
await api.shutdown();
process.exitCode = failed.length ? 1 : 0;
