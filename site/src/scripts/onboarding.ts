// 开户填写页面的交互逻辑（v3）。
// - 正式模式：通过 /api/onboarding/* 读写本人申请（令牌来自链接里的 ?t=）。
// - 原型模式（Vercel 预览环境）：使用内置的模拟接口，不调用后端，也不发送任何数据。

type Cfg = {
  prototype: boolean; lang: string; maxBytes: number;
  errors: Record<string, string>; nav: Record<string, string>;
  s4: { person: string }; s5: Record<string, string>; roles: Record<string, string>;
  locked?: string;
};
type FileRec = { id: string; name: string; size: number; doc: string; person?: string };
type State = {
  meta: { company: string; ref: string; expiresAt: string; status: string };
  form?: Record<string, any>; files?: FileRec[]; editable: string[]; uploadMode?: 'vercel' | 'local' | null; uploadPrefix?: string;
};

const root = document.getElementById('ob-root')!;
const cfg: Cfg = JSON.parse(root.dataset.config || '{}');
const form = document.getElementById('ob-form') as HTMLFormElement;
const steps = [...form.querySelectorAll<HTMLElement>('section[data-step]')];
const stepBtns = [...form.querySelectorAll<HTMLButtonElement>('[data-goto]')];
const alertBox = form.querySelector<HTMLElement>('[data-ob-alert]')!;
const saveStatus = form.querySelector<HTMLElement>('[data-save-status]')!;
const btnBack = form.querySelector<HTMLButtonElement>('[data-back]')!;
const btnNext = form.querySelector<HTMLButtonElement>('[data-next]')!;
const btnSave = form.querySelector<HTMLButtonElement>('[data-save]')!;
const btnSubmit = form.querySelector<HTMLButtonElement>('[data-submit]')!;
const peopleList = document.getElementById('people-list')!;
const personTpl = document.getElementById('person-tpl') as HTMLTemplateElement;
const personDocs = document.getElementById('person-docs')!;
const done = root.querySelector<HTMLElement>('[data-ob-done]')!;
const invalid = root.querySelector<HTMLElement>('[data-ob-invalid]')!;

/** 步骤序号 → 服务端的分组名 */
const STEP_SECTION = ['entity', 'contact', 'rep', 'people', 'docs', 'wallet', 'decl'];
const SAVE_SECTIONS = new Set(['entity', 'contact', 'rep', 'people', 'wallet', 'decl']);
let current = 0;
let personSeq = 0;
let editable = new Set(STEP_SECTION);
let files: FileRec[] = [];
const PHONE_RE = /^[0-9+\-() ]{5,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const token = new URLSearchParams(location.search).get('t') || '';

// ---------- 接口 ----------
class ApiError extends Error { constructor(public status: number, public body: any) { super(body?.error || String(status)); } }
async function call(path: string, init: RequestInit = {}) {
  const res = await fetch(`/api/onboarding/${path}`, { ...init, headers: { 'x-kyb-token': token, ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(init.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}
let uploadMode: State['uploadMode'] = null;
let uploadPrefix = '';
const realApi = {
  load: (): Promise<State> => call('state/'),
  save: (section: string, data: unknown) => call('save/', { method: 'POST', body: JSON.stringify({ section, data }) }),
  async upload(file: File, doc: string, person: string | undefined, onProgress: (p: number) => void): Promise<FileRec> {
    let pathname: string;
    if (uploadMode === 'vercel') {
      const { upload } = await import('@vercel/blob/client');
      const safe = file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || 'file';
      const r = await upload(`${uploadPrefix}${safe}`, file, {
        access: 'private', handleUploadUrl: '/api/onboarding/upload/', contentType: file.type,
        clientPayload: JSON.stringify({ token, doc, person: person || '' }),
        onUploadProgress: (e) => onProgress(Math.round(e.percentage)),
      });
      pathname = r.pathname;
    } else {
      onProgress(40);
      const q = new URLSearchParams({ doc, ...(person ? { person } : {}) });
      const r = await call(`local-upload/?${q}`, { method: 'POST', body: file, headers: { 'content-type': file.type } });
      pathname = r.pathname;
    }
    onProgress(100);
    const r = await call('file/', { method: 'POST', body: JSON.stringify({ pathname, doc, person, name: file.name }) });
    return r.file;
  },
  deleteFile: (id: string) => call('file-delete/', { method: 'POST', body: JSON.stringify({ fileId: id }) }),
  submit: (signature: string) => call('submit/', { method: 'POST', body: JSON.stringify({ signature }) }),
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const protoApi = {
  async load(): Promise<State> {
    return { meta: { company: 'Acme Export Ltd', ref: 'QC-2026-0001', expiresAt: new Date(Date.now() + 30 * 864e5).toISOString(), status: 'invited' }, form: {}, files: [], editable: STEP_SECTION, uploadMode: null };
  },
  async save() { await wait(300); return { ok: true }; },
  async upload(file: File, doc: string, person: string | undefined, onProgress: (p: number) => void): Promise<FileRec> {
    for (let p = 0; p <= 100; p += 20) { onProgress(p); await wait(80); }
    return { id: Math.random().toString(36).slice(2), name: file.name, size: file.size, doc, person };
  },
  async deleteFile() { return { ok: true }; },
  async submit() { await wait(500); return { ok: true }; },
};
const api = cfg.prototype ? protoApi : realApi;

// ---------- 字段读写 ----------
function isConditionallyHidden(el: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n && !n.matches('section[data-step]'); n = n.parentElement) if (n.hidden) return true;
  return false;
}
function valueOf(f: HTMLElement): any {
  const name = f.dataset.field!;
  const type = f.dataset.type;
  if (type === 'checkboxes') return [...f.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map((i) => i.value);
  if (type === 'radios') return f.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value || '';
  if (type === 'check') return f.querySelector<HTMLInputElement>('input')!.checked;
  return (f.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value || '').trim();
}
function setValue(f: HTMLElement, v: any) {
  const name = f.dataset.field!;
  const type = f.dataset.type;
  if (type === 'checkboxes') f.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((i) => (i.checked = Array.isArray(v) && v.includes(i.value)));
  else if (type === 'radios') f.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((i) => (i.checked = i.value === v));
  else if (type === 'check') f.querySelector<HTMLInputElement>('input')!.checked = v === true;
  else { const i = f.querySelector<HTMLInputElement>(`[name="${name}"]`); if (i) i.value = v ?? ''; }
  syncOther(f);
}
function syncOther(f: HTMLElement) {
  const name = f.dataset.field!;
  const other = f.querySelector<HTMLInputElement>(`[data-other-for="${name}"]`);
  if (other) { const v = valueOf(f); other.hidden = !(Array.isArray(v) ? v.includes('other') : v === 'other'); }
  if (name.endsWith('.pep')) f.closest('[data-person]')!.querySelector<HTMLElement>('[data-pep-details]')!.hidden = valueOf(f) !== 'yes';
}
/** 读取一个分组的数据：键名为字段名去掉分组前缀，"其他"输入框一并读取 */
function readGroup(scope: ParentNode, prefix: string) {
  const out: Record<string, any> = {};
  for (const f of scope.querySelectorAll<HTMLElement>(`[data-field^="${prefix}."]`)) {
    const key = f.dataset.field!.slice(prefix.length + 1);
    if (key.includes('.')) continue;
    out[key] = valueOf(f);
    const other = f.querySelector<HTMLInputElement>(`[data-other-for="${f.dataset.field}"]`);
    if (other) out[`${key}Other`] = other.hidden ? '' : other.value.trim();
  }
  return out;
}
function fillGroup(scope: ParentNode, prefix: string, data: Record<string, any> = {}) {
  for (const f of scope.querySelectorAll<HTMLElement>(`[data-field^="${prefix}."]`)) {
    const key = f.dataset.field!.slice(prefix.length + 1);
    if (key.includes('.') || !(key in data)) continue;
    setValue(f, data[key]);
    const other = f.querySelector<HTMLInputElement>(`[data-other-for="${f.dataset.field}"]`);
    if (other && data[`${key}Other`]) other.value = data[`${key}Other`];
  }
}
function readSection(section: string) {
  if (section === 'people') return [...peopleList.querySelectorAll<HTMLElement>('[data-person]')].map((c) => ({ ...readGroup(c, `people.${c.dataset.person}`), pid: c.dataset.person }));
  return readGroup(steps[STEP_SECTION.indexOf(section)], section);
}

// ---------- 校验 ----------
function setErr(f: HTMLElement, msg: string) {
  const out = f.querySelector<HTMLElement>(`[data-err-for="${f.dataset.field}"]`);
  if (out) out.textContent = msg;
  const input = f.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=radio]), select, textarea');
  if (input) msg ? input.setAttribute('aria-invalid', 'true') : input.removeAttribute('aria-invalid');
}
function validateField(f: HTMLElement): boolean {
  if (isConditionallyHidden(f)) { setErr(f, ''); return true; }
  const v = valueOf(f);
  const type = f.dataset.type;
  const name = f.dataset.field!;
  let msg = '';
  const empty = Array.isArray(v) ? v.length === 0 : v === '' || v === false;
  if (f.dataset.required && empty) msg = cfg.errors.required;
  else if (!empty && type === 'email' && !EMAIL_RE.test(String(v))) msg = cfg.errors.email;
  else if (!empty && type === 'tel' && !PHONE_RE.test(String(v))) msg = cfg.errors.phone;
  else if (!empty && type === 'date' && Number.isNaN(Date.parse(String(v)))) msg = cfg.errors.date;
  else if (!empty && name.endsWith('.passportExpiry') && String(v) <= new Date().toISOString().slice(0, 10)) msg = cfg.errors.future;
  const otherInput = f.querySelector<HTMLInputElement>(`[data-other-for="${name}"]`);
  if (!msg && otherInput && !otherInput.hidden && !otherInput.value.trim()) msg = cfg.errors.required;
  setErr(f, msg);
  return !msg;
}
function validateStep(i: number): boolean {
  const sec = steps[i];
  if (!editable.has(STEP_SECTION[i])) return true; // 补件时锁定的部分不再校验
  let ok = true;
  for (const f of sec.querySelectorAll<HTMLElement>('[data-field]')) if (!validateField(f)) ok = false;
  if (i === 3) ok = validatePeople() && ok;
  if (i === 4 || i === 5) ok = validateDocs(sec) && ok;
  if (i === 6) ok = validateSignature() && ok;
  showAlert(ok ? '' : cfg.errors.summary);
  if (!ok) sec.querySelector<HTMLElement>('[aria-invalid="true"], .err:not(:empty)')?.scrollIntoView({ block: 'center' });
  return ok;
}
function showAlert(msg: string) { alertBox.textContent = msg; alertBox.hidden = !msg; }

form.addEventListener('change', (e) => {
  const f = (e.target as HTMLElement).closest<HTMLElement>('[data-field]');
  if (!f) return;
  syncOther(f);
  const name = f.dataset.field!;
  if (name.endsWith('.roles') || name.endsWith('.fullName')) renderPersonDocs();
  if (f.querySelector('.err:not(:empty)')) validateField(f);
});
form.addEventListener('input', (e) => {
  const f = (e.target as HTMLElement).closest<HTMLElement>('[data-field]');
  if (f && f.querySelector('.err:not(:empty)')) validateField(f);
  saveStatus.textContent = '';
});

// ---------- 人员 ----------
function addPerson(pid?: string) {
  const id = pid ?? String(personSeq);
  personSeq = Math.max(personSeq, Number(id) + 1);
  const node = personTpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
  node.innerHTML = node.innerHTML.replaceAll('__i__', id);
  node.dataset.person = id;
  peopleList.appendChild(node);
  numberPeople();
  renderPersonDocs();
  return node;
}
function numberPeople() {
  const cards = [...peopleList.querySelectorAll<HTMLElement>('[data-person]')];
  cards.forEach((c, n) => {
    c.querySelector('[data-person-title]')!.textContent = `${cfg.s4.person} ${n + 1}`;
    c.querySelector<HTMLElement>('[data-remove-person]')!.hidden = cards.length === 1 || !editable.has('people');
  });
}
peopleList.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('[data-remove-person]');
  if (!b) return;
  const card = b.closest<HTMLElement>('[data-person]')!;
  files = files.filter((f) => f.person !== card.dataset.person); // 服务端保存"人员"时会同步删除该人员的文件
  card.remove();
  numberPeople();
  renderPersonDocs();
});
form.querySelector('[data-add-person]')!.addEventListener('click', () => addPerson());
function people() {
  return [...peopleList.querySelectorAll<HTMLElement>('[data-person]')].map((c) => {
    const id = c.dataset.person!;
    const roles = [...c.querySelectorAll<HTMLInputElement>(`input[name="people.${id}.roles"]:checked`)].map((x) => x.value);
    const name = (c.querySelector<HTMLInputElement>(`[name="people.${id}.fullName"]`)?.value || '').trim();
    return { id, roles, name };
  });
}
function validatePeople(): boolean {
  const ps = people();
  const out = form.querySelector<HTMLElement>('[data-err-for="people"]')!;
  const ok = ps.some((p) => p.roles.includes('director')) && ps.some((p) => p.roles.includes('ubo'));
  out.textContent = ok ? '' : cfg.errors.people;
  return ok;
}

// ---------- 文件 ----------
const docKey = (doc: string, person?: string) => (person ? `${doc}:${person}` : doc);
function renderPersonDocs() {
  const ps = people();
  personDocs.innerHTML = '';
  ps.forEach((p, n) => {
    for (const doc of ['passport', 'poa']) {
      const key = docKey(doc, p.id);
      const row = document.createElement('div');
      row.className = 'doc-row';
      row.dataset.doc = key;
      row.dataset.docRequired = '1';
      const roleText = p.roles.map((r) => cfg.roles[r]).join(' / ') || '—';
      row.innerHTML = `<div><div class="name"></div><span class="badge req-b"></span></div>
        <label class="btn btn-outline upload-btn"><span></span><input type="file" accept="application/pdf,image/jpeg,image/png" multiple /></label>
        <div class="files"></div>`;
      row.querySelector('input')!.dataset.upload = key;
      row.querySelector<HTMLElement>('.files')!.dataset.files = key;
      row.querySelector('.name')!.textContent = `${p.name || cfg.s4.person + ' ' + (n + 1)} (${roleText}) · ${cfg.s5[doc]}`;
      row.querySelector('.badge')!.textContent = cfg.s5.required;
      row.querySelector('label span')!.textContent = cfg.s5.upload;
      personDocs.appendChild(row);
      renderFiles(key);
    }
  });
  applyLocks();
}
const fmtSize = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
function renderFiles(key: string) {
  const box = form.querySelector<HTMLElement>(`[data-files="${CSS.escape(key)}"]`);
  if (!box) return;
  box.innerHTML = '';
  const section = key === 'walletProof' ? 'wallet' : 'docs';
  for (const f of files.filter((x) => docKey(x.doc, x.person) === key)) {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = '<span class="fname"></span><span class="ok"></span><button type="button" class="link-btn"></button>';
    chip.querySelector('.fname')!.textContent = `${f.name} · ${fmtSize(f.size)}`;
    chip.querySelector('.ok')!.textContent = '✓ ' + cfg.s5.uploaded;
    const rm = chip.querySelector('button')!;
    rm.textContent = cfg.s5.remove;
    rm.hidden = !editable.has(section);
    rm.addEventListener('click', async () => {
      rm.disabled = true;
      try { await api.deleteFile(f.id); files = files.filter((x) => x !== f); renderFiles(key); }
      catch { rm.disabled = false; showAlert(cfg.errors.summary); }
    });
    box.appendChild(chip);
  }
}
form.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const key = input.dataset?.upload;
  if (!key || !input.files) return;
  const [doc, person] = key.split(':');
  const box = form.querySelector<HTMLElement>(`[data-files="${CSS.escape(key)}"]`)!;
  const row = input.closest<HTMLElement>('.doc-row')!;
  // 上传人员文件前，先保存人员（服务端要求文件属于已保存的人员）
  if (person && !cfg.prototype) await api.save('people', readSection('people')).catch(() => {});
  for (const file of [...input.files]) {
    const bad = !['application/pdf', 'image/jpeg', 'image/png'].includes(file.type) ? cfg.errors.fileType : file.size > cfg.maxBytes ? cfg.errors.fileSize : '';
    if (bad) { showRowError(row, `${file.name}: ${bad}`); continue; }
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = '<span class="fname"></span><span class="progress"><span></span></span>';
    chip.querySelector('.fname')!.textContent = file.name;
    box.appendChild(chip);
    const bar = chip.querySelector<HTMLElement>('.progress span')!;
    try {
      const rec = await api.upload(file, doc, person, (p) => (bar.style.width = p + '%'));
      files.push(rec);
      row.querySelector('.row-err')?.remove();
    } catch (err) {
      chip.remove();
      const code = (err as ApiError).body?.error;
      showRowError(row, `${file.name}: ${code === 'file_size' ? cfg.errors.fileSize : code === 'file_type' ? cfg.errors.fileType : cfg.errors.summary}`);
    }
    renderFiles(key);
  }
  input.value = '';
});
function showRowError(row: HTMLElement, msg: string) {
  let e = row.querySelector<HTMLElement>('.row-err');
  if (!e) { e = document.createElement('p'); e.className = 'err row-err span-all'; row.appendChild(e); }
  e.textContent = msg;
}
function validateDocs(sec: HTMLElement): boolean {
  let ok = true;
  for (const row of sec.querySelectorAll<HTMLElement>('[data-doc-required]')) {
    const has = files.some((f) => docKey(f.doc, f.person) === row.dataset.doc);
    if (!has) { ok = false; showRowError(row, cfg.errors.required); } else row.querySelector('.row-err')?.remove();
  }
  const out = sec.querySelector<HTMLElement>('[data-err-for="docs"]');
  if (out) out.textContent = ok ? '' : cfg.errors.docs;
  return ok;
}

// ---------- 签名 ----------
const canvas = form.querySelector<HTMLCanvasElement>('[data-signature]')!;
const ctx = canvas.getContext('2d')!;
let drawing = false;
let signed = false;
function sizeCanvas() {
  const r = canvas.getBoundingClientRect();
  if (!r.width) return;
  const dpr = window.devicePixelRatio || 1;
  // 尺寸没变时保留已签的内容（来回切换步骤不会清掉签名）
  if (canvas.width === Math.round(r.width * dpr) && canvas.height === Math.round(r.height * dpr)) return;
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0B1F3A';
  signed = false;
}
const pos = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
canvas.addEventListener('pointerdown', (e) => { drawing = true; canvas.setPointerCapture(e.pointerId); const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); });
canvas.addEventListener('pointermove', (e) => { if (!drawing) return; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); signed = true; });
canvas.addEventListener('pointerup', () => { drawing = false; if (signed) form.querySelector<HTMLElement>('[data-err-for="signature"]')!.textContent = ''; });
form.querySelector('[data-sig-clear]')!.addEventListener('click', () => { ctx.clearRect(0, 0, canvas.width, canvas.height); signed = false; });
function validateSignature(): boolean {
  form.querySelector<HTMLElement>('[data-err-for="signature"]')!.textContent = signed ? '' : cfg.errors.signature;
  return signed;
}

// ---------- 补件时锁定未开放的部分 ----------
function applyLocks() {
  steps.forEach((sec, i) => {
    const locked = !editable.has(STEP_SECTION[i]);
    sec.querySelectorAll<HTMLInputElement>('input, select, textarea, button:not([data-goto])').forEach((el) => (el.disabled = locked));
    sec.classList.toggle('is-locked', locked);
    let note = sec.querySelector<HTMLElement>('.lock-note');
    if (locked && !note && cfg.locked) { note = document.createElement('p'); note.className = 'notice lock-note'; note.textContent = cfg.locked; sec.insertBefore(note, sec.children[2] || null); }
    if (!locked) note?.remove();
  });
}

// ---------- 导航与保存 ----------
function show(i: number) {
  current = i;
  steps.forEach((s, n) => (s.hidden = n !== i));
  stepBtns.forEach((b, n) => {
    b.parentElement!.classList.toggle('done', n < i);
    n === i ? b.setAttribute('aria-current', 'step') : b.removeAttribute('aria-current');
  });
  steps[i].querySelector<HTMLElement>('[data-step-label]')!.textContent = cfg.nav.stepOf.replace('{n}', String(i + 1)).replace('{total}', String(steps.length));
  btnBack.hidden = i === 0;
  btnNext.hidden = i === steps.length - 1;
  btnSubmit.hidden = i !== steps.length - 1;
  btnSave.hidden = !SAVE_SECTIONS.has(STEP_SECTION[i]) || !editable.has(STEP_SECTION[i]);
  showAlert('');
  if (i === 4) renderPersonDocs();
  if (i === 6) requestAnimationFrame(sizeCanvas);
  window.scrollTo({ top: 0 });
}
async function save(i = current) {
  const section = STEP_SECTION[i];
  if (!SAVE_SECTIONS.has(section) || !editable.has(section)) return true;
  btnSave.disabled = true;
  try {
    await api.save(section, readSection(section));
    saveStatus.textContent = '✓ ' + cfg.nav.saved;
    return true;
  } catch (err) {
    showServerErrors((err as ApiError).body?.fields);
    return false;
  } finally { btnSave.disabled = false; }
}
/** 服务端返回的字段错误：显示在对应字段旁（例如 "entity.legalName"、"people.0.dob"、"docs.d1"） */
function showServerErrors(fields?: Record<string, string>) {
  if (!fields) { showAlert(cfg.errors.summary); return; }
  let firstStep = -1;
  for (const [k, code] of Object.entries(fields)) {
    const msg = cfg.errors[code] || cfg.errors.required;
    const f = form.querySelector<HTMLElement>(`[data-field="${CSS.escape(k)}"]`);
    if (f) setErr(f, msg);
    const [grp] = k.split('.');
    const step = grp === 'signature' ? 6 : STEP_SECTION.indexOf(grp);
    if (step >= 0 && (firstStep < 0 || step < firstStep)) firstStep = step;
  }
  if (firstStep >= 0 && firstStep !== current) show(firstStep);
  showAlert(cfg.errors.summary);
}
btnSave.addEventListener('click', () => save());
btnBack.addEventListener('click', () => show(Math.max(0, current - 1)));
btnNext.addEventListener('click', async () => { if (!validateStep(current)) return; if (await save()) show(current + 1); });
stepBtns.forEach((b, n) => b.addEventListener('click', () => { if (n <= current || validateStep(current)) show(n); }));
btnSubmit.addEventListener('click', async () => {
  for (let i = 0; i < steps.length; i++) if (!validateStep(i)) { show(i); validateStep(i); return; }
  btnSubmit.disabled = true;
  try {
    if (!(await save())) return;
    await api.submit(canvas.toDataURL('image/png'));
    form.hidden = true;
    done.hidden = false;
    done.focus();
  } catch (err) {
    showServerErrors((err as ApiError).body?.fields);
  } finally { btnSubmit.disabled = false; }
});

// ---------- 启动 ----------
(async () => {
  let st: State;
  try {
    if (!cfg.prototype && !token) throw new Error('no token');
    st = await api.load();
  } catch {
    invalid.hidden = false;
    return;
  }
  const m = st.meta;
  const set = (k: string, v: string) => { const el = root.querySelector(`[data-meta="${k}"]`); if (el) el.textContent = v; };
  set('company', m.company); set('ref', m.ref); set('expires', String(m.expiresAt).slice(0, 10));
  if (!st.editable.length) { done.hidden = false; return; } // 已提交或已审核：只显示状态，不返回资料
  editable = new Set(st.editable);
  uploadMode = st.uploadMode || null;
  uploadPrefix = st.uploadPrefix || '';
  const f = st.form || {};
  for (const g of ['entity', 'contact', 'rep', 'wallet', 'decl']) fillGroup(form, g, f[g]);
  const ppl: any[] = Array.isArray(f.people) && f.people.length ? f.people : [{ pid: '0' }];
  for (const p of ppl) { const card = addPerson(String(p.pid)); fillGroup(card, `people.${p.pid}`, p); }
  files = st.files || [];
  for (const key of ['walletProof', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd10', 'd11', 'd12', 'd13', 'd14', 'd15', 'd16']) renderFiles(key);
  renderPersonDocs();
  applyLocks();
  form.hidden = false;
  const first = STEP_SECTION.findIndex((s) => editable.has(s));
  show(first < 0 ? 0 : first);
})();
