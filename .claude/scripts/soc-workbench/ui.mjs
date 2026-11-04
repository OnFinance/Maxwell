export const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Maxwell | SOC workbench</title><link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head>
<body><header><div><span class="eyebrow">ONFINANCE / SECURITY OPERATIONS</span><h1>Maxwell</h1></div><div id="identity"></div></header>
<main><div class="banner">Review, investigate, approve. Live response execution is disabled in this workbench.</div>
<p id="message" role="status" aria-live="polite"></p><section id="login"><h2>Your investigation workspace</h2><p>Sign in with your organization to review cases and response requests.</p><a class="button" href="/auth/login">Sign in</a></section>
<section id="workspace" hidden><div class="toolbar"><label>Company <select id="company"></select></label><button id="refresh">Refresh</button><button id="logout">Sign out</button></div>
<nav aria-label="Workbench views"><button id="casesTab" aria-pressed="true">Cases</button><button id="responsesTab" aria-pressed="false">Response approvals</button></nav>
<div class="layout"><section class="panel"><h2 id="listTitle">Cases</h2><label>Filter loaded items <input id="filter" type="search" placeholder="Title, status or owner"></label><div id="list"></div><button id="more" hidden>Load more</button></section><section id="detail" class="panel"><h2>Select a case</h2><p>Evidence and activity will appear here.</p></section></div></section></main></body></html>`;

export const CSS = `:root{font-family:Inter,system-ui,sans-serif;color:#172b3a;background:#edf2f4}*{box-sizing:border-box}body{margin:0}header{background:#102c3a;color:white;padding:25px 5%;display:flex;align-items:center;justify-content:space-between}h1{margin:5px 0;font-size:30px;letter-spacing:-1px}h2{font-size:21px;margin-top:0}h3{font-size:15px;margin-top:24px}.eyebrow{font-size:10px;letter-spacing:2px;color:#92b8c6}main{max-width:1500px;margin:auto;padding:24px 5%}.banner{padding:14px 18px;border-left:4px solid #16847d;background:#deeeeb;font-size:14px}#message{min-height:24px;color:#9b321b;overflow-wrap:anywhere}.toolbar,nav{display:flex;align-items:center;gap:12px;margin:18px 0}.toolbar label{margin-right:auto}.layout{display:grid;grid-template-columns:minmax(300px,1fr) minmax(350px,1.4fr);gap:20px}.panel,#login{background:white;border:1px solid #dae3e7;border-radius:8px;padding:23px;min-width:0}button,.button{font:inherit;cursor:pointer;border:1px solid #b4c9ce;background:#fff;color:#174955;border-radius:5px;padding:9px 13px;text-decoration:none;display:inline-block}button:hover,.button:hover{background:#eaf4f3}button:disabled{opacity:.45;cursor:default}nav button[aria-pressed=true],.primary{background:#17665f;color:white;border-color:#17665f}label{font-size:13px;display:block;margin:10px 0}input,select,textarea{font:inherit;display:block;width:100%;padding:9px;border:1px solid #bdcdd3;border-radius:4px;margin-top:5px}textarea{min-height:75px}.toolbar select{min-width:220px}table{width:100%;border-collapse:collapse;font-size:13px;margin-top:16px}td,th{text-align:left;padding:10px 6px;border-bottom:1px solid #e5ebee;overflow-wrap:anywhere}th{color:#5f7480;font-weight:500}td button{border:0;padding:0;background:none;text-align:left;font-weight:600}.badge{display:inline-block;border-radius:20px;background:#e6eeee;padding:4px 9px;font-size:12px}dl{display:grid;grid-template-columns:130px 1fr;font-size:13px;gap:10px}dt{color:#637985}dd{margin:0;overflow-wrap:anywhere}pre{background:#f3f6f7;padding:12px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:300px;overflow:auto}form{border-top:1px solid #e2e9eb;margin-top:22px;padding-top:15px}form h3{margin-top:0}.actions{display:flex;gap:8px;flex-wrap:wrap}.muted{font-size:13px;color:#627782}#more{margin-top:15px}#identity{font-size:12px;max-width:45%;overflow-wrap:anywhere}[hidden]{display:none!important}@media(max-width:850px){.layout{grid-template-columns:1fr}main{padding:16px}.toolbar{flex-wrap:wrap}header{padding:20px}dl{grid-template-columns:100px 1fr}}`;

function clientApp() {
  const $ = (id) => document.getElementById(id);
  let session; let mode = 'cases'; let items = []; let next = null; let epoch = 0;
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  const can = (permission) => session?.companies.find((c) => c.companyId === $('company').value)?.permissions.includes(permission);
  const base = () => `/api/companies/${encodeURIComponent($('company').value)}`;
  const message = (text = '') => { $('message').textContent = text; };
  async function api(path, data) {
    const response = await fetch(path, { credentials: 'same-origin', ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf }, body: JSON.stringify(data) }) });
    const result = await response.json();
    if (response.status === 401) { $('workspace').hidden = true; $('login').hidden = false; }
    if (!response.ok) throw new Error(result.error || 'Request failed');
    return result;
  }
  async function work(fn) {
    const controls = [...document.querySelectorAll('button,select')]; controls.forEach((e) => { e.disabled = true; });
    message();
    try { await fn(); } catch (error) { message(error.message); }
    finally { controls.forEach((e) => { e.disabled = false; }); }
  }
  function values(container, data) {
    const dl = node('dl');
    for (const [name, value] of Object.entries(data)) { dl.append(node('dt', name), node('dd', String(value ?? '—'))); }
    container.append(dl);
  }
  function dump(container, title, value) { container.append(node('h3', title), node('pre', JSON.stringify(value, null, 2))); }
  function button(label, fn) { const b = node('button', label); b.type = 'button'; b.onclick = () => work(fn); return b; }
  function form(container, title, definitions, submit, label = 'Save') {
    const f = node('form'); f.append(node('h3', title));
    const controls = {};
    for (const [key, name, options] of definitions) {
      const l = node('label', name); const input = node(Array.isArray(options) ? 'select' : options === 'text' ? 'textarea' : 'input');
      if (Array.isArray(options)) for (const value of options) { const o = node('option', value); o.value = value; input.append(o); }
      input.required = true; input.name = key; l.append(input); f.append(l); controls[key] = input;
    }
    const b = node('button', label, 'primary'); b.type = 'submit'; f.append(b);
    f.onsubmit = (event) => { event.preventDefault(); work(() => submit(Object.fromEntries(Object.entries(controls).map(([key, el]) => [key, el.value])))); };
    container.append(f);
  }
  function list() {
    const root = $('list'); root.replaceChildren();
    const filtered = items.filter((item) => JSON.stringify([item.title, item.status, item.state, item.owner, item.proposal?.caseId]).toLowerCase().includes($('filter').value.toLowerCase()));
    if (!filtered.length) { root.append(node('p', 'No matching items on the loaded pages.', 'muted')); return; }
    const table = node('table'); const head = node('tr');
    ['Item', 'Status', mode === 'cases' ? 'Severity' : 'Action'].forEach((title) => head.append(node('th', title))); table.append(head);
    for (const item of filtered) {
      const row = node('tr'); const name = node('td');
      name.append(button(mode === 'cases' ? item.title : item.proposal.caseId, () => detail(mode === 'cases' ? item.caseId : item.responseId)));
      row.append(name, node('td', item.status || item.state), node('td', item.severity || item.proposal.action)); table.append(row);
    }
    root.append(table);
  }
  async function refresh(more = false) {
    const generation = ++epoch;
    if (!more) { items = []; next = null; $('detail').replaceChildren(node('h2', 'Select an item')); }
    const result = await api(`${base()}/${mode}${more && next ? `?after=${encodeURIComponent(next)}` : ''}`);
    if (generation !== epoch) return;
    items.push(...result.items); next = result.next; $('more').hidden = !next; list();
  }
  async function detail(id) {
    const selectedMode = mode; const selectedCompany = $('company').value;
    const item = await api(`${base()}/${mode}/${encodeURIComponent(id)}`);
    if (selectedMode !== mode || selectedCompany !== $('company').value) return;
    const root = $('detail'); root.replaceChildren(node('h2', mode === 'cases' ? item.title : 'Review response proposal'));
    root.append(node('span', item.status || item.state, 'badge'));
    if (mode === 'cases') {
      values(root, { Case: item.caseId, Severity: item.severity, Owner: item.owner, Revision: item.revision, Source: item.alert.source });
      dump(root, 'Latest provider alert', item.alert);
      if (item.providerReviewRequired) root.append(node('p', 'Provider evidence changed. Review the latest alert before confirming or requesting a response.', 'muted'));
      dump(root, 'Evidence', item.evidence); dump(root, 'Notes', item.notes); dump(root, 'Activity', item.timeline);
      const action = async (type, data = {}) => { await api(`${base()}/cases/${item.caseId}/actions`, { type, expectedRevision: item.revision, ...data }); await detail(item.caseId); message('Case updated.'); };
      if (can('case.write')) {
        if (item.providerReviewRequired && item.status !== 'confirmation-pending') form(root, 'Review provider update', [['text', 'Review note', 'text']], (data) => action('review-provider-update', { ...data, alertSignature: item.alertSignature }), 'Record review');
        if (item.status === 'open') root.append(button('Start investigation', () => action('start')));
        if (['open', 'investigating'].includes(item.status)) {
          form(root, 'Assign case', [['owner', 'Owner']], (data) => action('assign', data));
          form(root, 'Add note', [['text', 'Note', 'text']], (data) => action('note', data));
          form(root, 'Add evidence', [['ref', 'Evidence reference'], ['sha256', 'SHA-256'], ['description', 'Description', 'text']], (data) => action('add-evidence', data));
          form(root, 'Dismiss as false positive', [['reason', 'Reason', 'text']], (data) => action('dismiss', data), 'Dismiss');
        }
        if (['confirmed', 'false-positive'].includes(item.status)) root.append(button('Close case', () => action('close')));
      }
      if (!item.providerReviewRequired && can('case.confirm') && ['open', 'investigating', 'confirmation-pending'].includes(item.status)) {
        form(root, 'Confirm incident', [['category', 'Incident category', ['other', 'malware', 'ransomware', 'unauthorised-access', 'data-breach', 'phishing']], ['classification', 'Affected data', ['none', 'pii', 'spdi', 'financial', 'cardholder', 'confidential']]],
          ({ category, classification }) => action('confirm', { category, affectedDataClassifications: classification === 'none' ? [] : [classification] }), 'Confirm incident');
      }
      if (!item.providerReviewRequired && can('response.request') && ['confirmed', 'closed'].includes(item.status) && item.alert.source === 'microsoft-defender') {
        form(root, 'Request device response', [['providerAlertId', 'Defender alert ID'], ['machineId', 'Defender device ID'], ['action', 'Action', item.status === 'closed' ? ['unisolate'] : ['isolate', 'unisolate']], ['reason', 'Reason and expected impact', 'text']], async (data) => {
          const response = await api(`${base()}/responses`, { ...data, caseId: item.caseId }); mode = 'responses'; tabs(); await refresh(); await detail(response.responseId);
        }, 'Request approval');
      }
    } else {
      const p = item.proposal;
      values(root, { Case: p.caseId, Tenant: p.tenantId, Device: p.machineId, Action: p.action, Requester: p.requestedBy,
        Reason: p.reason, Expires: new Date(p.expiresAt).toLocaleString(), Revision: item.revision, Digest: item.digest, 'Evidence hash': p.evidenceHash, 'Policy hash': p.policyHash || 'Legacy host policy', 'Policy window ends': p.policyValidUntil ? new Date(p.policyValidUntil).toISOString() : 'Not bound by this host' });
      root.append(node('p', p.action === 'isolate' ? 'Full isolation can interrupt device connectivity and business services. Review the device and impact before approving.' : 'Release restores device connectivity. Confirm remediation before approving.', 'banner'));
      const decision = async (value) => { await api(`${base()}/responses/${item.responseId}/decision`, { expectedRevision: item.revision, digest: item.digest, decision: value }); await detail(item.responseId); };
      if (p.expiresAt <= Date.now()) root.append(node('p', 'This approval has expired. Request a new proposal.', 'muted'));
      else {
        const actions = node('div', undefined, 'actions');
        if (item.state === 'requested' && can('response.approve') && p.requestedBy !== session.actorId) actions.append(button('Approve reviewed proposal', () => decision('approve')), button('Deny', () => decision('deny')));
        if (['requested', 'approved'].includes(item.state) && can('response.cancel')) actions.append(button('Cancel request', () => decision('cancel')));
        root.append(actions);
      }
      if (['executing', 'unknown', 'submitted'].includes(item.state) && can('response.reconcile')) form(root, 'Check provider outcome', [['providerActionId', 'Defender action ID']], async (data) => {
        await api(`${base()}/responses/${item.responseId}/reconcile`, { ...data, expectedRevision: item.revision }); await detail(item.responseId);
      }, 'Reconcile status');
      dump(root, 'Approval and execution history', item.timeline);
    }
  }
  function tabs() { $('casesTab').setAttribute('aria-pressed', String(mode === 'cases')); $('responsesTab').setAttribute('aria-pressed', String(mode === 'responses')); $('listTitle').textContent = mode === 'cases' ? 'Cases' : 'Response approvals'; }
  $('filter').oninput = list;
  $('refresh').onclick = () => work(() => refresh()); $('more').onclick = () => work(() => refresh(true));
  $('company').onchange = () => work(() => refresh());
  for (const name of ['cases', 'responses']) $(`${name}Tab`).onclick = () => work(async () => { mode = name; tabs(); await refresh(); });
  $('logout').onclick = () => work(async () => { await api('/auth/logout', {}); location.assign('/'); });
  work(async () => {
    session = await api('/api/session');
    $('identity').textContent = `Signed in · ${session.subject}`;
    for (const c of session.companies) { const o = node('option', c.companyId); o.value = c.companyId; $('company').append(o); }
    $('login').hidden = true; $('workspace').hidden = false; await refresh();
  });
}
export const SCRIPT = `(${clientApp.toString()})();`;
