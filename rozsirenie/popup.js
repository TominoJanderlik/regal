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
  $('#site').textContent = web ? origin.replace(/^https?:\/\//, '') : 'Adresu tejto stránky rozšírenie nevidí – klikni na ikonu Regál priamo na stránke.';
  // Balíkovo (ps.sps-sro.sk) je zapnuté natrvalo priamo v rozšírení
  const builtin = (chrome.runtime.getManifest().content_scripts || []).flatMap((c) => c.matches).map((m) => m.replace(/\/\*$/, ''));
  const isBuiltin = web && builtin.includes(origin);
  const on = web && (isBuiltin || st.sites?.includes(origin));
  $('#enable').hidden = !web || on;
  $('#disable').hidden = !on || isBuiltin;
  if (isBuiltin) { $('#site-msg').className = 'ok'; $('#site-msg').textContent = 'Balíkovo – zapnuté automaticky ✓'; }
  // diagnostika: beží skript na tejto karte a vidí číslo zásielky?
  $('#diag').textContent = '';
  if (on && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'ping' }, (r) => {
      const d = $('#diag');
      if (chrome.runtime.lastError || !r) { d.className = 'err'; d.textContent = 'Na tejto karte zatiaľ nebeží – obnov stránku (F5).'; return; }
      d.className = 'ok';
      d.textContent = r.number ? `Beží ✓ · nájdené číslo ${r.number}` : `Beží ✓ · čaká na číslo zásielky${r.labels ? '' : ' (štítok „Číslo zásielky“ zatiaľ nevidím)'}`;
      // ak je obsah stránky vo vloženom ráme z inej adresy, treba zapnúť aj ten
      const box = $('#frames');
      box.innerHTML = '';
      for (const fo of r.frames || []) {
        if (st.sites?.includes(fo)) continue;
        const b = document.createElement('button');
        b.textContent = `Zapnúť aj pre vložený rám ${fo.replace(/^https?:\/\//, '')}`;
        b.style.width = '100%';
        b.addEventListener('click', async () => {
          if (!(await chrome.permissions.request({ origins: [`${fo}/*`] }))) return;
          await send({ type: 'enableSite', origin: fo, tabId: tab.id });
          $('#site-msg').className = 'ok'; $('#site-msg').textContent = 'Zapnuté. Obnov stránku (F5).';
          refresh();
        });
        box.append(b);
      }
    });
  }
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
