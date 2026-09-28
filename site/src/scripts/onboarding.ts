// 开户填写页面的交互逻辑。
// 原型模式（Vercel 预览环境）：使用内置的模拟数据，不调用任何接口，也不发送任何数据。
// 正式模式：通过 api/onboarding/* 读写（在正式开发阶段实现，见《技术方案 v3》）。

type Cfg = {
  prototype: boolean; lang: string; maxBytes: number;
  errors: Record<string, string>; nav: Record<string, string>;
  s4: { person: string }; s5: Record<string, string>; roles: Record<string, string>;
};
type FileRec = { id: string; name: string; size: number; doc: string; person?: string };

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

let current = 0;
let personSeq = 0;
const files: FileRec[] = [];
const PHONE_RE = /^[0-9+\-() ]{5,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- 数据接口：原型用模拟实现 ----------
const api = cfg.prototype
  ? {
      async load() {
        return { company: 'Acme Export Ltd', ref: 'QC-2026-0001', expires: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) };
      },
      async save(_data: unknown) { await new Promise((r) => setTimeout(r, 300)); },
      async upload(file: File, onProgress: (p: number) => void) {
        for (let p = 0; p <= 100; p += 20) { onProgress(p); await new Promise((r) => setTimeout(r, 80)); }
        return { id: Math.random().toString(36).slice(2) };
      },
      async submit(_data: unknown) { await new Promise((r) => setTimeout(r, 500)); },
    }
  : null;

// ---------- 通用字段读写与校验 ----------
/** 字段是否被"步骤内部"的条件隐藏（例如未选 PEP 时的说明框）。步骤区块本身的隐藏不算。 */
function isConditionallyHidden(el: HTMLElement): boolean {
  for (let n: HTMLElement | null = el; n && !n.matches('section[data-step]'); n = n.parentElement) {
    if (n.hidden) return true;
  }
  return false;
}
function valueOf(f: HTMLElement): string | string[] | boolean {
  const name = f.dataset.field!;
  const type = f.dataset.type;
  if (type === 'checkboxes') return [...f.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map((i) => i.value);
  if (type === 'radios') return f.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value || '';
  if (type === 'check') return f.querySelector<HTMLInputElement>('input')!.checked;
  return (f.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value || '').trim();
}
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
  else if (!empty && name.endsWith('.passportExpiry') && Date.parse(String(v)) <= Date.now()) msg = cfg.errors.future;
  // "其他"选项被选中时，"请注明"输入框必填
  const otherInput = f.querySelector<HTMLInputElement>(`[data-other-for="${name}"]`);
  if (!msg && otherInput && !otherInput.hidden && !otherInput.value.trim()) msg = cfg.errors.required;
  setErr(f, msg);
  return !msg;
}
function validateStep(i: number): boolean {
  const sec = steps[i];
  let ok = true;
  for (const f of sec.querySelectorAll<HTMLElement>('[data-field]')) if (!validateField(f)) ok = false;
  if (i === 3) ok = validatePeople() && ok;
  if (i === 4 || i === 5) ok = validateDocs(sec) && ok;
  if (i === 6) ok = validateSignature() && ok;
  alertBox.textContent = ok ? '' : cfg.errors.summary;
  alertBox.hidden = ok;
  if (!ok) sec.querySelector<HTMLElement>('[aria-invalid="true"], .err:not(:empty)')?.scrollIntoView({ block: 'center' });
  return ok;
}

// "其他"选项联动；PEP 联动
form.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  const f = t.closest<HTMLElement>('[data-field]');
  if (f) {
    const name = f.dataset.field!;
    const other = f.querySelector<HTMLInputElement>(`[data-other-for="${name}"]`);
    if (other) {
      const v = valueOf(f);
      other.hidden = !(Array.isArray(v) ? v.includes('other') : v === 'other');
    }
    if (name.endsWith('.pep')) {
      const card = f.closest('[data-person]')!;
      card.querySelector<HTMLElement>('[data-pep-details]')!.hidden = valueOf(f) !== 'yes';
    }
    if (name.endsWith('.roles') || name.endsWith('.fullName')) renderPersonDocs();
    if (f.querySelector('.err:not(:empty)')) validateField(f);
  }
});
form.addEventListener('input', (e) => {
  const f = (e.target as HTMLElement).closest<HTMLElement>('[data-field]');
  if (f && f.querySelector('.err:not(:empty)')) validateField(f);
  saveStatus.textContent = '';
});

// ---------- 人员 ----------
function addPerson() {
  const i = personSeq++;
  const node = personTpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
  node.innerHTML = node.innerHTML.replaceAll('__i__', String(i));
  node.dataset.person = String(i);
  peopleList.appendChild(node);
  numberPeople();
  renderPersonDocs();
}
function numberPeople() {
  const cards = [...peopleList.querySelectorAll<HTMLElement>('[data-person]')];
  cards.forEach((c, n) => {
    c.querySelector('[data-person-title]')!.textContent = `${cfg.s4.person} ${n + 1}`;
    c.querySelector<HTMLElement>('[data-remove-person]')!.hidden = cards.length === 1;
  });
}
peopleList.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('[data-remove-person]');
  if (!b) return;
  const card = b.closest<HTMLElement>('[data-person]')!;
  const id = card.dataset.person!;
  card.remove();
  for (let k = files.length - 1; k >= 0; k--) if (files[k].person === id) files.splice(k, 1);
  numberPeople();
  renderPersonDocs();
});
form.querySelector('[data-add-person]')!.addEventListener('click', addPerson);
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
function renderPersonDocs() {
  const ps = people();
  personDocs.innerHTML = '';
  ps.forEach((p, n) => {
    for (const doc of ['passport', 'poa']) {
      const key = `${doc}:${p.id}`;
      const row = document.createElement('div');
      row.className = 'doc-row';
      row.dataset.doc = key;
      row.dataset.docRequired = '1';
      const roleText = p.roles.map((r) => cfg.roles[r]).join(' / ') || '—';
      row.innerHTML = `<div><div class="name"></div><span class="badge req-b"></span></div>
        <label class="btn btn-outline upload-btn"><span></span><input type="file" accept="application/pdf,image/jpeg,image/png" multiple data-upload="${key}" /></label>
        <div class="files" data-files="${key}"></div>`;
      row.querySelector('.name')!.textContent = `${p.name || cfg.s4.person + ' ' + (n + 1)} (${roleText}) · ${cfg.s5[doc]}`;
      row.querySelector('.badge')!.textContent = cfg.s5.required;
      row.querySelector('label span')!.textContent = cfg.s5.upload;
      personDocs.appendChild(row);
      renderFiles(key);
    }
  });
}
function renderFiles(key: string) {
  const box = form.querySelector<HTMLElement>(`[data-files="${CSS.escape(key)}"]`);
  if (!box) return;
  box.innerHTML = '';
  for (const f of files.filter((x) => x.doc === key)) {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = '<span class="fname"></span><span class="ok"></span><button type="button" class="link-btn"></button>';
    chip.querySelector('.fname')!.textContent = `${f.name} · ${f.size >= 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(f.size / 1024)) + ' KB'}`;
    chip.querySelector('.ok')!.textContent = '✓ ' + cfg.s5.uploaded;
    const rm = chip.querySelector('button')!;
    rm.textContent = cfg.s5.remove;
    rm.addEventListener('click', () => { files.splice(files.indexOf(f), 1); renderFiles(key); });
    box.appendChild(chip);
  }
}
form.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const key = input.dataset?.upload;
  if (!key || !input.files) return;
  const box = form.querySelector<HTMLElement>(`[data-files="${CSS.escape(key)}"]`)!;
  const row = input.closest<HTMLElement>('.doc-row')!;
  for (const file of [...input.files]) {
    const bad = !['application/pdf', 'image/jpeg', 'image/png'].includes(file.type) ? cfg.errors.fileType : file.size > cfg.maxBytes ? cfg.errors.fileSize : '';
    if (bad) { showRowError(row, `${file.name}: ${bad}`); continue; }
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = '<span class="fname"></span><span class="progress"><span></span></span>';
    chip.querySelector('.fname')!.textContent = file.name;
    box.appendChild(chip);
    const bar = chip.querySelector<HTMLElement>('.progress span')!;
    const r = await api!.upload(file, (p) => (bar.style.width = p + '%'));
    files.push({ id: r.id, name: file.name, size: file.size, doc: key, person: key.includes(':') ? key.split(':')[1] : undefined });
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
    const has = files.some((f) => f.doc === row.dataset.doc);
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
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  ctx.scale(dpr, dpr);
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

// ---------- 步骤导航 ----------
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
  alertBox.hidden = true;
  if (i === 4) renderPersonDocs();
  if (i === 6) requestAnimationFrame(sizeCanvas);
  window.scrollTo({ top: 0 });
}
async function save() {
  btnSave.disabled = true;
  await api!.save({});
  btnSave.disabled = false;
  saveStatus.textContent = '✓ ' + cfg.nav.saved;
}
btnSave.addEventListener('click', save);
btnBack.addEventListener('click', () => show(Math.max(0, current - 1)));
btnNext.addEventListener('click', async () => { if (!validateStep(current)) return; await save(); show(current + 1); });
stepBtns.forEach((b, n) => b.addEventListener('click', () => { if (n <= current || validateStep(current)) show(n); }));
btnSubmit.addEventListener('click', async () => {
  for (let i = 0; i < steps.length; i++) if (!validateStep(i)) { show(i); validateStep(i); return; }
  btnSubmit.disabled = true;
  await api!.submit({});
  form.hidden = true;
  done.hidden = false;
  done.focus();
});

// ---------- 启动 ----------
(async () => {
  if (!api) {
    // 正式模式的接口将在正式开发阶段接入；在此之前，非原型环境显示"链接无效"
    root.querySelector<HTMLElement>('[data-ob-invalid]')!.hidden = false;
    return;
  }
  const meta = await api.load();
  for (const [k, v] of Object.entries(meta)) { const el = root.querySelector(`[data-meta="${k}"]`); if (el) el.textContent = v; }
  addPerson();
  form.hidden = false;
  show(0);
})();
