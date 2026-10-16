// claim/claim.js — the script for the guest claim page (claim/index.html).
//
// Kept in its own file so the page's Content-Security-Policy can allow
// scripts only from this site and jsDelivr, with no inline script at all.
// Deploy BOTH files to the divz-claim GitHub Pages repo (see README.md).
// Pinned to an exact version (the one the app ships). An unpinned "@2" ran
// whatever jsDelivr currently serves as the newest 2.x with full control of
// this page. Bump it deliberately, never implicitly.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.104.1/+esm";

// Public anon key — same one shipped in the app. RLS (and the SECURITY DEFINER
// claim_* functions) are the real boundary, not this string.
const SUPABASE_URL = "https://wjeipxlnzixhzysrjbsb.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_mgpKZbHq9L-MP8v7OsrTww_d0rbQXfC";
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// The session id is the capability. Read it from ?s= or the hash so the link
// works either way.
const params = new URLSearchParams(location.search);
const sessionId = params.get("s") || location.hash.replace(/^#/, "");

const app = document.getElementById("app");
const bar = document.getElementById("bar");
const totalEl = document.getElementById("total");
const statusEl = document.getElementById("status");

const money = (n) => "$" + (Number(n) || 0).toFixed(2);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Summaries stay readable for 30 days (enforced server-side too).
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

// Remember who you are per session, so a refresh doesn't make you re-join —
// and so you can get back to your summary after the bill closes. This lives
// only in this browser: a web page can't read a phone's device id.
const meKey = "divz_claim_" + sessionId;
const HISTORY_KEY = "divz_claim_history";
let me = null;       // { id, name }
let data = null;     // last snapshot from claim_session_get
let busy = new Set();
let claimPoll = null;
let summaryPoll = null;

function fail(msg) {
  app.innerHTML = '<div class="msg err">' + esc(msg) + "</div>";
  bar.hidden = true;
}

function unavailable(error) {
  return /session_unavailable/.test((error && error.message) || "");
}

// ── Recent bills, kept in this browser ─────────────────────────────────────
function readHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return list.filter((h) => h && h.s && Date.now() - (h.joinedAt || 0) < KEEP_MS);
  } catch { return []; }
}

// Keeps the original join time so the 30-day window counts from joining.
function remember(restaurant) {
  try {
    const all = readHistory();
    const prev = all.find((h) => h.s === sessionId);
    const list = all.filter((h) => h.s !== sessionId);
    list.unshift({
      s: sessionId,
      restaurant: restaurant || (prev && prev.restaurant) || "",
      joinedAt: (prev && prev.joinedAt) || Date.now(),
    });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 30)));
  } catch {}
}

function renderHistory() {
  bar.hidden = true;
  const list = readHistory();
  if (list.length === 0) {
    fail("This link is missing its bill code. Open the link or QR code you were sent.");
    return;
  }
  app.innerHTML = `
    <h1>Your recent bills</h1>
    <p class="sub">Bills you joined on this device in the last 30 days.</p>
    <div id="hist"></div>`;
  const box = document.getElementById("hist");
  for (const h of list) {
    const a = document.createElement("a");
    a.className = "hist";
    // After "#", not "?s=": the part after # is never sent to the web server,
    // so the bill id stays out of its logs. (Old ?s= links still open.)
    a.href = "./#" + encodeURIComponent(h.s);
    a.innerHTML = `<div class="card"><strong>${esc(h.restaurant || "Split bill")}</strong>
      <div class="muted">${esc(new Date(h.joinedAt).toLocaleDateString())}</div></div>`;
    box.appendChild(a);
  }
}

// ── Live claiming ──────────────────────────────────────────────────────────
async function load() {
  const { data: res, error } = await sb.rpc("claim_session_get", { p_session: sessionId });
  if (error) return { error };
  data = res;
  return { res };
}

function myClaims() {
  if (!me || !data) return new Set();
  return new Set(
    (data.selections || []).filter((s) => s.participant_id === me.id).map((s) => s.item_id)
  );
}

// Your share of an item = its price split between everyone who claimed it.
function myItemsSubtotal() {
  if (!me || !data) return 0;
  const mine = myClaims();
  return (data.items || []).reduce((sum, it) => {
    if (!mine.has(String(it.id))) return sum;
    const n = (data.selections || []).filter((s) => s.item_id === String(it.id)).length || 1;
    return sum + (Number(it.price) || 0) / n;
  }, 0);
}

// Tax, tip and discount ride along in proportion to your share of the
// subtotal — the same way the app distributes them when the bill is
// finalized. Showing items-only here would quote people a number lower than
// what they actually end up owing.
function myTotal() {
  const items = myItemsSubtotal();
  if (!data || items <= 0) return { items: 0, extras: 0, total: 0 };
  const base = Number(data.subtotal) || (data.items || []).reduce((s, i) => s + (Number(i.price) || 0), 0);
  const share = base > 0 ? items / base : 0;
  const extras = share * ((Number(data.tax) || 0) + (Number(data.tip) || 0) - (Number(data.discount) || 0));
  return { items, extras, total: items + extras };
}

function paintTotal() {
  const t = myTotal();
  totalEl.textContent = money(t.total);
  document.getElementById("totalNote").textContent =
    t.extras > 0.004 ? money(t.items) + " + " + money(t.extras) + " tax/tip" : "";
}

async function adopt(pid, name) {
  me = { id: pid, name };
  try { localStorage.setItem(meKey, JSON.stringify(me)); } catch {}
  remember(data && data.restaurant);
  const { error } = await load();
  if (error) return onClosed(error);
  renderItems();
}

// Pick your name from the people already on the bill, or add yourself.
function renderJoin() {
  bar.hidden = true;
  const people = data.participants || [];
  app.innerHTML = `
    <h1>${esc(data.restaurant || "Split the bill")}</h1>
    <p class="sub">${people.length
      ? "Who are you? Tap your name, then the items you had."
      : "Add your name, then tap the items you had."}</p>
    <div id="names"></div>
    <div id="typed" ${people.length ? "hidden" : ""}>
      <div class="card">
        <label for="nm">Your name</label>
        <input id="nm" autocomplete="given-name" placeholder="e.g. Sam" />
      </div>
      <button id="go" disabled>Join</button>
    </div>
    <p class="sub" style="margin-top:14px">No account needed.</p>`;

  const names = document.getElementById("names");
  for (const p of people) {
    const b = document.createElement("button");
    b.className = "pick";
    const dot = document.createElement("span");
    dot.className = "dot";
    if (p.color) dot.style.background = p.color;
    b.appendChild(dot);
    b.appendChild(document.createTextNode(p.name));
    // Goes by id, not name, so two people with the same name can both be picked.
    b.addEventListener("click", async () => {
      b.disabled = true;
      const { error } = await sb.rpc("claim_pick", { p_session: sessionId, p_participant: p.id });
      if (error) {
        b.disabled = false;
        if (unavailable(error)) return onClosed(error);
        alert("Couldn't pick that name: " + error.message);
        return;
      }
      await adopt(p.id, p.name);
    });
    names.appendChild(b);
  }

  const typed = document.getElementById("typed");
  if (people.length) {
    const other = document.createElement("button");
    other.className = "pick ghost";
    other.textContent = "Someone else — type my name";
    other.addEventListener("click", () => {
      typed.hidden = false;
      other.hidden = true;
      document.getElementById("nm").focus();
    });
    names.appendChild(other);
  }

  const nm = document.getElementById("nm");
  const go = document.getElementById("go");
  nm.addEventListener("input", () => { go.disabled = !nm.value.trim(); });
  nm.addEventListener("keydown", (e) => { if (e.key === "Enter" && nm.value.trim()) go.click(); });
  go.addEventListener("click", async () => {
    go.disabled = true; go.textContent = "Joining…";
    const { data: pid, error } = await sb.rpc("claim_join", {
      p_session: sessionId, p_name: nm.value.trim(), p_color: null,
    });
    if (error) {
      go.disabled = false; go.textContent = "Join";
      if (unavailable(error)) return onClosed(error);
      alert("Couldn't join: " + error.message);
      return;
    }
    await adopt(pid, nm.value.trim());
  });
  if (!people.length) nm.focus();
}

function renderItems() {
  const mine = myClaims();
  const byItem = {};
  for (const s of data.selections || []) (byItem[s.item_id] ||= []).push(s.participant_id);
  const nameOf = Object.fromEntries((data.participants || []).map((p) => [p.id, p.name]));

  app.innerHTML = `
    <h1>${esc(data.restaurant || "Split the bill")}</h1>
    <p class="sub">Hi ${esc(me.name)} — tap everything you had. Shared plates divide automatically.</p>
    <div id="items"></div>
    <p class="muted" id="others"></p>`;

  const list = document.getElementById("items");
  for (const it of data.items || []) {
    const id = String(it.id);
    const holders = byItem[id] || [];
    const others = holders.filter((h) => h !== (me && me.id)).map((h) => nameOf[h]).filter(Boolean);
    const el = document.createElement("div");
    el.className = "item" + (mine.has(id) ? " mine" : "");
    el.innerHTML = `
      <div class="tick">${mine.has(id) ? "✓" : ""}</div>
      <div class="name">${esc(it.quantity > 1 ? it.quantity + "× " : "")}${esc(it.name)}
        ${others.length ? `<span class="who">also: ${esc(others.join(", "))}</span>` : ""}
      </div>
      <div class="price">${money(it.price)}</div>`;
    el.addEventListener("click", () => toggle(id, el));
    list.appendChild(el);
  }

  const joined = (data.participants || []).map((p) => p.name);
  document.getElementById("others").textContent =
    joined.length > 1 ? "Also here: " + joined.filter((n) => n !== me.name).join(", ") : "";

  bar.hidden = false;
  paintTotal();
}

async function toggle(itemId, el) {
  if (busy.has(itemId)) return;
  busy.add(itemId);
  // Optimistic: flip immediately, reconcile from the server response.
  const wasMine = el.classList.contains("mine");
  el.classList.toggle("mine", !wasMine);
  el.querySelector(".tick").textContent = !wasMine ? "✓" : "";
  statusEl.textContent = "Saving…";

  const { data: nowMine, error } = await sb.rpc("claim_toggle", {
    p_session: sessionId, p_participant: me.id, p_item: itemId,
  });
  busy.delete(itemId);

  if (error) {
    el.classList.toggle("mine", wasMine);          // roll the optimistic flip back
    el.querySelector(".tick").textContent = wasMine ? "✓" : "";
    statusEl.textContent = "";
    if (unavailable(error)) return onClosed(error);
    alert("Couldn't save that: " + error.message);
    return;
  }
  // Keep the local snapshot in step so the running total stays honest without
  // a full refetch on every tap.
  data.selections = (data.selections || []).filter(
    (s) => !(s.participant_id === me.id && s.item_id === itemId)
  );
  if (nowMine) data.selections.push({ participant_id: me.id, item_id: itemId });
  paintTotal();
  statusEl.textContent = "Saved";
  setTimeout(() => { if (statusEl.textContent === "Saved") statusEl.textContent = ""; }, 1200);
}

// ── After the bill closes ──────────────────────────────────────────────────
// Claiming has stopped. Instead of a dead end, show what you picked and owe:
// an estimate until the host saves the bill, then the final numbers.
function onClosed(error) {
  if (claimPoll) { clearInterval(claimPoll); claimPoll = null; }
  if (!unavailable(error)) {
    return fail("Couldn't load this bill. " + ((error && error.message) || ""));
  }
  if (!me) {
    return fail("This bill is closed. Your summary is only available on the phone or browser you joined from.");
  }
  showSummary();
}

async function showSummary() {
  bar.hidden = true;
  const { data: sum, error } = await sb.rpc("claim_summary_get", {
    p_session: sessionId, p_participant: me.id,
  });
  if (error) {
    if (summaryPoll) { clearInterval(summaryPoll); summaryPoll = null; }
    return fail(/session_unavailable|participant_not_in_session/.test(error.message || "")
      ? "This bill's summary is no longer available. Summaries are kept for 30 days."
      : "Couldn't load your summary. " + error.message);
  }
  remember(sum.restaurant);
  renderSummary(sum);

  if (sum.finalized) {
    if (summaryPoll) { clearInterval(summaryPoll); summaryPoll = null; }
  } else if (!summaryPoll) {
    // Waiting on the host to finalize — re-check so this flips to Final on its own.
    summaryPoll = setInterval(showSummary, 30000);
  }
}

function itemRow(it, share, shared) {
  return `<div class="row"><span>${esc(it.quantity > 1 ? it.quantity + "× " : "")}${esc(it.name)}</span>
    <span>${money(share)}${shared ? ` <span class="of">of ${money(it.price)}</span>` : ""}</span></div>`;
}

function renderSummary(sum) {
  const title = `<h1>${esc(sum.restaurant || "Split bill")}</h1>`;
  if (sum.removed) {
    app.innerHTML = `${title}<div class="card"><span class="badge">Final</span>
      <p style="margin:0">You're not on the final bill — nothing to pay.</p></div>`;
    return;
  }

  let rows = "";
  let items = 0, tax = 0, tip = 0, total = 0, discountLine = "";
  if (sum.finalized) {
    for (const it of sum.items || []) {
      const share = Number(it.share) || 0;
      rows += itemRow(it, share, Math.abs(share - (Number(it.price) || 0)) > 0.005);
    }
    items = sum.subtotal; tax = sum.tax; tip = sum.tip; total = sum.total;
  } else {
    // Same distribution the claim page used while it was open.
    for (const it of sum.items || []) {
      const n = Math.max(1, Number(it.claimants) || 1);
      const share = (Number(it.price) || 0) / n;
      items += share;
      rows += itemRow(it, share, n > 1);
    }
    const base = Number(sum.subtotal) || 0;
    const shareOf = base > 0 ? items / base : 0;
    tax = shareOf * (Number(sum.tax) || 0);
    tip = shareOf * (Number(sum.tip) || 0);
    const disc = shareOf * (Number(sum.discount) || 0);
    if (disc > 0.004) discountLine = `<div class="row"><span>Discount</span><span>−${money(disc)}</span></div>`;
    total = items + tax + tip - disc;
  }

  const payers = (sum.payers || []).filter(Boolean);
  const payLine = sum.finalized && payers.length
    ? `<p class="sub" style="margin:12px 0 0">${payers.length === 1
        ? "Pay " + esc(payers[0])
        : "Paid by " + esc(payers.join(", "))}</p>`
    : "";

  const badge = sum.finalized
    ? '<span class="badge">Final</span>'
    : '<span class="badge est">Estimate — waiting for the host to finalize</span>';
  const empty = '<p class="muted" style="margin:0 0 6px">You didn&#39;t claim any items.</p>';

  app.innerHTML = `${title}
    <p class="sub">Your share${me ? ", " + esc(me.name) : ""}.</p>
    <div class="card">
      ${badge}
      ${rows || empty}
      <div class="row"><span>Items</span><span>${money(items)}</span></div>
      ${discountLine}
      <div class="row"><span>Tax</span><span>${money(tax)}</span></div>
      <div class="row"><span>Tip</span><span>${money(tip)}</span></div>
      <div class="row total"><span>You owe</span><span>${money(total)}</span></div>
      ${payLine}
    </div>
    <p class="muted">Saved on this device for 30 days. <a href="./">Your recent bills</a></p>`;
}

async function start() {
  if (!sessionId) return renderHistory();

  const { error } = await load();
  if (error) {
    // Closed or expired: fall back to the summary if this browser joined.
    try { me = JSON.parse(localStorage.getItem(meKey) || "null"); } catch { me = null; }
    return onClosed(error);
  }

  try {
    const saved = JSON.parse(localStorage.getItem(meKey) || "null");
    // Only trust the saved identity if that participant still exists.
    if (saved && (data.participants || []).some((p) => p.id === saved.id)) me = saved;
  } catch {}
  if (me) { remember(data.restaurant); renderItems(); } else renderJoin();

  // Someone else claiming a shared plate changes YOUR share, so refresh
  // periodically. Guests can't subscribe to Realtime (RLS gives anon no table
  // access by design), so this is a poll. It stops once the bill closes.
  claimPoll = setInterval(async () => {
    if (!me || busy.size) return;
    const before = JSON.stringify(data.selections) + JSON.stringify(data.participants);
    const { error: pollErr } = await load();
    if (pollErr) return onClosed(pollErr);
    if (JSON.stringify(data.selections) + JSON.stringify(data.participants) !== before) renderItems();
  }, 5000);
}

// Following a link to a different bill from this page changes only the hash.
window.addEventListener("hashchange", () => location.reload());

start();
