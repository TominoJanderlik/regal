// Regál – okno rozšírenia: prihlásenie a zapnutie na aktuálnej stránke
const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, (x) => r(x || { ok: false, error: chrome.runtime.lastError?.message })));
let tab = null, origin = null;

async function refresh() {
  const st = await send({ type: 'status' });
  $('#login').hidden = Boolean(st.email);
  $('#account').hidden = !st.email;
  $('#email').textContent = st.email || '';
  $('#sites').innerHTML = st.sites?.length ? st.sites.map((s) => `<li>${s.replace(/^https?:\/\//, '')}</li>`).join('') : '<li>žiadne</li>';
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { origin = new URL(tab.url).origin; } catch { origin = null; }
  const web = origin && /^https?:/.test(origin);
  $('#site').textContent = web ? origin.replace(/^https?:\/\//, '') : 'Táto stránka sa nedá použiť.';
  const on = web && st.sites?.includes(origin);
  $('#enable').hidden = !web || on;
  $('#disable').hidden = !on;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-msg').textContent = 'Prihlasujem…';
  const f = e.target;
  const r = await send({ type: 'login', email: f.email.value.trim(), password: f.password.value });
  $('#login-msg').textContent = r.ok ? '' : r.error;
  if (r.ok) { f.reset(); refresh(); }
});
$('#logout').addEventListener('click', async () => { await send({ type: 'logout' }); refresh(); });

$('#enable').addEventListener('click', async () => {
  // povolenie musí potvrdiť používateľ – rozšírenie nečíta žiadne iné stránky
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) { $('#site-msg').textContent = 'Povolenie nebolo udelené.'; return; }
  const r = await send({ type: 'enableSite', origin, tabId: tab.id });
  $('#site-msg').className = r.ok ? 'ok' : 'err';
  $('#site-msg').textContent = r.ok ? 'Zapnuté. Okienko sa ukáže po zobrazení čísla zásielky.' : r.error;
  refresh();
});
$('#disable').addEventListener('click', async () => {
  await send({ type: 'disableSite', origin });
  $('#site-msg').className = '';
  $('#site-msg').textContent = 'Vypnuté. Obnov stránku (F5).';
  refresh();
});

refresh();
