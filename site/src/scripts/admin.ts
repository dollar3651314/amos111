// 审核后台的交互逻辑。
// 原型模式：使用内置的模拟数据（均为虚构），所有操作只改页面上的数据，不调用任何接口。
// 正式模式：通过 api/admin/*（在正式开发阶段实现）。

const root = document.getElementById('admin-root')!;
const PROTO = root.dataset.prototype === '1';
const $ = <T extends Element = HTMLElement>(sel: string, el: ParentNode = root) => el.querySelector<T>(sel)!;

const STATUS: Record<string, string> = {
  invited: '已邀请', in_progress: '填写中', submitted: '已提交', needs_info: '需要补件',
  approved: '已通过', rejected: '已拒绝', expired: '已过期',
};
const SECTIONS = ['① 企业信息', '② 公司联系方式', '③ 授权联系人', '④ 人员', '⑤ 文件', '⑥ 钱包授权声明', '⑦ 声明与签名'];

type Person = { name: string; roles: string[]; dob: string; nationality: string; residence: string; address: string; passport: string; passportCountry: string; passportExpiry: string; pep: string; email: string; phone: string };
type App = {
  id: string; ref: string; company: string; email: string; status: string; updated: string; retention: string;
  invitedAt: string; submittedAt?: string; expiresAt: string;
  entity?: Record<string, string>; contact?: Record<string, string>; rep?: Record<string, string>;
  people?: Person[]; files?: { doc: string; name: string; size: string; person?: string }[];
  wallet?: Record<string, string>; decl?: { name: string; position: string; signedAt: string; ip: string };
  review: { reviewer?: string; reviewDate?: string; notes?: string; received?: string };
  log: string[];
};

// ---------- 模拟数据（虚构，仅用于原型） ----------
const today = new Date();
const d = (days: number) => new Date(today.getTime() + days * 864e5).toISOString().slice(0, 10);
const apps: App[] = [
  {
    id: 'a1', ref: 'QC-2026-0003', company: 'Acme Export Ltd', email: 'ops@acme-export.example', status: 'submitted',
    updated: d(0), retention: d(365), invitedAt: d(-6), submittedAt: d(0), expiresAt: d(24),
    entity: {
      法定全称: 'Acme Export Limited', 商号: 'Acme', 法律形式: 'Ltd', 注册号: '202012345K', 成立日期: '2020-04-18',
      注册国家和地点: 'Singapore', 注册地址: '10 Anson Road, #20-01, Singapore 079903', 实际经营地址: '同注册地址',
      LEI: '—', 税号: 'T20SG1234A', 业务性质: '外贸出口、跨境 B2B 贸易', 业务关系用途: '处理客户充值和提现',
      预计月交易量: '10 万到 50 万', 目标市场: '亚太、中东', 集团或母公司: '—',
    },
    contact: { 官网: 'acme-export.example', 邮箱: 'ops@acme-export.example', 电话: '+65 6000 1234', 其他: 'Telegram @acmeops' },
    rep: { 姓名: 'Jane Tan', 邮箱: 'jane@acme-export.example', 电话: '+65 9000 1111', 其他: '—' },
    people: [
      { name: 'Jane Tan', roles: ['董事', 'UBO', '授权签字人'], dob: '1984-02-11', nationality: 'Singapore', residence: 'Singapore', address: '8 Demo Street, Singapore', passport: 'K1234567X', passportCountry: 'Singapore', passportExpiry: '2031-05-01', pep: '否', email: 'jane@acme-export.example', phone: '+65 9000 1111' },
      { name: 'Wei Lim', roles: ['UBO'], dob: '1979-09-30', nationality: 'Malaysia', residence: 'Singapore', address: '21 Sample Road, Singapore', passport: 'A98765432', passportCountry: 'Malaysia', passportExpiry: '2029-11-20', pep: '否', email: 'wei@acme-export.example', phone: '+65 9000 2222' },
    ],
    files: [
      { doc: '1. 公司注册证书', name: 'certificate-of-incorporation.pdf', size: '1.2 MB' },
      { doc: '2. 存续证明（90 天内）', name: 'good-standing-2026-09.pdf', size: '0.4 MB' },
      { doc: '3. 公司章程', name: 'constitution.pdf', size: '2.8 MB' },
      { doc: '4. 股东名册', name: 'register-of-members.pdf', size: '0.3 MB' },
      { doc: '5. 公司地址证明', name: 'utility-bill-aug.pdf', size: '0.6 MB' },
      { doc: '6. 组织架构图', name: 'org-chart.png', size: '0.2 MB' },
      { doc: '护照', name: 'jane-passport.jpg', size: '1.9 MB', person: 'Jane Tan' },
      { doc: '地址证明', name: 'jane-poa.pdf', size: '0.5 MB', person: 'Jane Tan' },
      { doc: '护照', name: 'wei-passport.jpg', size: '2.1 MB', person: 'Wei Lim' },
      { doc: '地址证明', name: 'wei-poa.pdf', size: '0.4 MB', person: 'Wei Lim' },
      { doc: '钱包所有权证明', name: 'wallet-screenshot.png', size: '0.7 MB' },
    ],
    wallet: { 全称: 'Acme Export Limited', 证件: '公司注册号 202012345K', 'User ID': '—', 邮箱: 'ops@acme-export.example', 钱包地址: 'TXYZ…DEMO…9Kp2', 网络: 'TRON', 用途: '两者', 所有权声明: '已确认', 风险确认: '已确认', 证明方式: '钱包服务商截图' },
    decl: { name: 'Jane Tan', position: 'Director', signedAt: `${d(0)} 10:42 (UTC+8)`, ip: '203.0.113.24' },
    review: { received: d(0) },
    log: [`${d(-6)} 发送开户链接`, `${d(-4)} 客户开始填写`, `${d(0)} 客户提交`],
  },
  { id: 'a2', ref: 'QC-2026-0002', company: 'Northwind Manufacturing Co.', email: 'finance@northwind.example', status: 'in_progress', updated: d(-1), retention: d(364), invitedAt: d(-3), expiresAt: d(27), review: {}, log: [`${d(-3)} 发送开户链接`, `${d(-1)} 客户保存了第 3 步`] },
  { id: 'a3', ref: 'QC-2026-0001', company: 'Blue Harbor Trading', email: 'admin@blueharbor.example', status: 'needs_info', updated: d(-2), retention: d(360), invitedAt: d(-12), submittedAt: d(-5), expiresAt: d(18), review: { reviewer: 'Amos', reviewDate: d(-2), notes: '存续证明超过 90 天，需重新提供。' }, log: [`${d(-12)} 发送开户链接`, `${d(-5)} 客户提交`, `${d(-2)} 要求补件：⑤ 文件`] },
  { id: 'a4', ref: 'QC-2026-0000', company: 'Old Lead Pte Ltd', email: 'hello@oldlead.example', status: 'expired', updated: d(-31), retention: d(334), invitedAt: d(-61), expiresAt: d(-31), review: {}, log: [`${d(-61)} 发送开户链接`, `${d(-31)} 链接过期`] },
];
const leads = [
  { at: `${d(0)} 09:12`, company: 'Sunrise Furniture Export', name: 'Li Ming', email: 'li@sunrise.example', country: 'Vietnam', industry: '外贸出口', invited: false },
  { at: `${d(-1)} 16:40`, company: 'Northwind Manufacturing Co.', name: 'Anna Berg', email: 'finance@northwind.example', country: 'Germany', industry: '制造业', invited: true },
  { at: `${d(-3)} 11:05`, company: 'QA TEST - 可删除', name: 'QA Tester', email: 'qa-test@example.com', country: 'Singapore', industry: '外贸出口', invited: false },
];

// ---------- 视图切换 ----------
const views = [...root.querySelectorAll<HTMLElement>('[data-view]')];
const panels = [...root.querySelectorAll<HTMLElement>('[data-panel]')];
const showView = (v: string) => views.forEach((x) => (x.hidden = x.dataset.view !== v));
const showPanel = (p: string) => {
  panels.forEach((x) => (x.hidden = x.dataset.panel !== p));
  root.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => (b.dataset.tab === p || (p === 'detail' && b.dataset.tab === 'apps') ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  window.scrollTo({ top: 0 });
};
function toast(msg: string) {
  const t = $('[data-toast]');
  t.textContent = msg;
  t.hidden = false;
  setTimeout(() => (t.hidden = true), 2500);
}
const el = (tag: string, cls = '', text = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
const statusBadge = (s: string) => el('span', `status st-${s}`, STATUS[s]);

// ---------- 登录 ----------
$('[data-login]').addEventListener('submit', (e) => {
  e.preventDefault();
  const otp = $<HTMLInputElement>('#a-otp').value.trim();
  if (!/^[0-9]{6}$/.test(otp) || !$<HTMLInputElement>('#a-pw').value) {
    const er = $('[data-login-err]'); er.textContent = '密码或动态码不正确。'; er.hidden = false; return;
  }
  showView('app'); renderList(); showPanel('apps');
});
$('[data-logout]').addEventListener('click', () => showView('login'));
root.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => { const p = b.dataset.tab!; if (p === 'leads') renderLeads(); else renderList(); showPanel(p); }));

// ---------- 列表 ----------
let filter = 'all';
function renderFilters() {
  const box = $('[data-filters]'); box.innerHTML = '';
  for (const [k, label] of [['all', '全部'], ...Object.entries(STATUS)]) {
    const n = k === 'all' ? apps.length : apps.filter((a) => a.status === k).length;
    const b = el('button', '', `${label} ${n}`) as HTMLButtonElement;
    b.type = 'button'; b.setAttribute('aria-pressed', String(filter === k));
    b.addEventListener('click', () => { filter = k; renderList(); });
    box.appendChild(b);
  }
}
function renderList() {
  renderFilters();
  $('[data-count="apps"]').textContent = String(apps.filter((a) => a.status === 'submitted').length || '');
  $('[data-count="leads"]').textContent = String(leads.filter((l) => !l.invited).length || '');
  const body = $('[data-apps-body]'); body.innerHTML = '';
  for (const a of apps.filter((x) => filter === 'all' || x.status === filter)) {
    const tr = el('tr');
    tr.append(el('td', '', a.ref), el('td', '', a.company));
    const st = el('td'); st.appendChild(statusBadge(a.status)); tr.appendChild(st);
    tr.append(el('td', '', a.updated), el('td', '', a.retention));
    tr.tabIndex = 0;
    tr.addEventListener('click', () => openDetail(a.id));
    tr.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') openDetail(a.id); });
    body.appendChild(tr);
  }
}
function renderLeads() {
  const body = $('[data-leads-body]'); body.innerHTML = '';
  for (const l of leads) {
    const tr = el('tr');
    tr.append(el('td', '', l.at), el('td', '', l.company), el('td', '', `${l.name} · ${l.email}`), el('td', '', l.country), el('td', '', l.industry));
    const td = el('td');
    const b = el('button', 'btn btn-primary', l.invited ? '已发送' : '发送开户链接') as HTMLButtonElement;
    b.type = 'button'; b.disabled = l.invited;
    b.addEventListener('click', (e) => { e.stopPropagation(); inviteDialog(l.company, l.email, () => { l.invited = true; renderLeads(); }); });
    td.appendChild(b); tr.appendChild(td);
    body.appendChild(tr);
  }
}

// ---------- 对话框 ----------
const dlg = $<HTMLDialogElement>('[data-dialog]');
function dialog(title: string, body: HTMLElement, okText: string, onOk: () => boolean | void, danger = false) {
  $('[data-dialog-title]').textContent = title;
  const b = $('[data-dialog-body]'); b.innerHTML = ''; b.appendChild(body);
  const ok = $<HTMLButtonElement>('[data-dialog-ok]'); ok.textContent = okText; ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  dlg.returnValue = '';
  dlg.onclose = () => { if (dlg.returnValue === 'ok') onOk(); };
  dlg.showModal();
}
function inviteDialog(company: string, email: string, after?: () => void) {
  const body = el('div', 'stack');
  body.innerHTML = `<div class="f"><label for="i-co">企业名称</label><input id="i-co" /></div><div class="f"><label for="i-em">客户邮箱</label><input id="i-em" type="email" /></div><p class="hint m0">系统会生成一个 30 天有效的专属链接，并用你的邮箱发送给客户。</p>`;
  (body.querySelector('#i-co') as HTMLInputElement).value = company;
  (body.querySelector('#i-em') as HTMLInputElement).value = email;
  dialog('发送开户链接', body, '发送', () => {
    const co = (body.querySelector('#i-co') as HTMLInputElement).value || '新客户';
    const em = (body.querySelector('#i-em') as HTMLInputElement).value;
    apps.unshift({ id: 'n' + Date.now(), ref: `QC-2026-000${apps.length + 1}`, company: co, email: em, status: 'invited', updated: d(0), retention: d(365), invitedAt: d(0), expiresAt: d(30), review: {}, log: [`${d(0)} 发送开户链接（原型：未实际发送）`] });
    after?.(); renderList(); toast('已发送开户链接（原型：未实际发送）');
  });
}
$('[data-new-invite]').addEventListener('click', () => inviteDialog('', ''));

// ---------- 详情 ----------
function kvCard(title: string, data: Record<string, string>, idx: number) {
  const card = el('section', 'card section-card');
  const h = el('h3'); h.append(el('span', '', title)); card.appendChild(h);
  const dl = el('dl', 'kv');
  for (const [k, v] of Object.entries(data)) { dl.append(el('dt', '', k), el('dd', '', v)); }
  card.appendChild(dl);
  card.dataset.section = String(idx);
  return card;
}
function openDetail(id: string) {
  const a = apps.find((x) => x.id === id)!;
  const box = $('[data-detail-sections]'); box.innerHTML = '';
  const head = el('div', 'toolbar');
  const h = el('h1', 'm0', a.company); head.appendChild(h); head.appendChild(statusBadge(a.status));
  box.appendChild(head);
  if (!a.entity) {
    box.appendChild(el('p', 'notice', a.status === 'expired' ? '客户在链接有效期内没有提交。可以在右侧重新发送链接。' : '客户尚未提交，提交后才能查看完整资料。'));
  } else {
    box.appendChild(kvCard(SECTIONS[0], a.entity, 0));
    box.appendChild(kvCard(SECTIONS[1], a.contact!, 1));
    box.appendChild(kvCard(SECTIONS[2], a.rep!, 2));
    a.people!.forEach((p, i) => box.appendChild(kvCard(`${SECTIONS[3]} · ${i + 1}. ${p.name}（${p.roles.join(' / ')}）`, {
      出生日期: p.dob, 国籍: p.nationality, 居住国: p.residence, 住址: p.address, 护照号码: p.passport, 签发国: p.passportCountry, 到期日: p.passportExpiry, PEP: p.pep, 邮箱: p.email, 电话: p.phone,
    }, 3)));
    const fc = el('section', 'card section-card'); fc.appendChild(el('h3', '', SECTIONS[4]));
    for (const f of a.files!) {
      const row = el('div', 'file-link');
      const left = el('span', '', f.doc); if (f.person) left.appendChild(el('span', 'pill-person', f.person));
      const link = el('a', '', `${f.name} · ${f.size}`) as HTMLAnchorElement; link.href = '#'; link.addEventListener('click', (e) => { e.preventDefault(); toast('原型：正式版会通过后台函数安全下载'); });
      row.append(left, link); fc.appendChild(row);
    }
    box.appendChild(fc);
    box.appendChild(kvCard(SECTIONS[5], a.wallet!, 5));
    const sc = kvCard(SECTIONS[6], { 授权代表: a.decl!.name, 职位: a.decl!.position, 签署时间: a.decl!.signedAt, 签署IP: a.decl!.ip }, 6);
    const img = el('img', 'sig-img') as HTMLImageElement; img.src = '/proto/signature-sample.svg'; img.alt = '客户手写签名'; sc.appendChild(img);
    box.appendChild(sc);
  }
  renderSide(a);
  showPanel('detail');
}
function renderSide(a: App) {
  const side = $('[data-side]'); side.innerHTML = '';
  side.appendChild(el('h3', 'm0', '审核'));
  const dl = el('dl', 'kv');
  const info: Record<string, string> = { 编号: a.ref, 客户邮箱: a.email, 发送链接: a.invitedAt, 链接有效期至: a.expiresAt, 提交时间: a.submittedAt || '—', 收件日期: a.review.received || '—', 审核人: a.review.reviewer || '—', 审核日期: a.review.reviewDate || '—', 保留截止: a.retention };
  for (const [k, v] of Object.entries(info)) dl.append(el('dt', '', k), el('dd', '', v));
  side.appendChild(dl);
  const notes = el('div', 'f');
  notes.innerHTML = '<label for="rv-notes">内部备注（客户看不到）</label><textarea id="rv-notes" rows="3"></textarea>';
  (notes.querySelector('textarea') as HTMLTextAreaElement).value = a.review.notes || '';
  notes.querySelector('textarea')!.addEventListener('change', (e) => { a.review.notes = (e.target as HTMLTextAreaElement).value; toast('备注已保存（原型）'); });
  side.appendChild(notes);
  const act = (text: string, cls: string, fn: () => void, show = true) => { if (!show) return; const b = el('button', `btn ${cls}`, text) as HTMLButtonElement; b.type = 'button'; b.addEventListener('click', fn); side.appendChild(b); };
  const decide = (status: string, label: string) => { a.status = status; a.review.reviewer = 'Amos'; a.review.reviewDate = d(0); a.updated = d(0); a.log.push(`${d(0)} ${label}`); openDetail(a.id); toast(`已${label}（原型）`); };
  const canReview = a.status === 'submitted';
  act('通过', 'btn-primary', () => dialog('确认通过', el('p', 'm0', `确认通过 ${a.company} 的开户申请？之后请线下完成开户。`), '通过', () => decide('approved', '通过')), canReview);
  act('要求补件', 'btn-outline', () => {
    const body = el('div', 'stack');
    body.appendChild(el('p', 'm0', '勾选需要客户修改的部分。客户只能修改这些部分。'));
    const ch = el('div', 'choices');
    SECTIONS.forEach((s, i) => { const l = el('label'); l.innerHTML = `<input type="checkbox" value="${i}" />`; l.append(s); ch.appendChild(l); });
    body.appendChild(ch);
    const msg = el('div', 'f'); msg.innerHTML = '<label for="ni-msg">给客户的说明（会写进邮件）</label><textarea id="ni-msg" rows="3"></textarea>'; body.appendChild(msg);
    dialog('要求补件', body, '发送补件通知', () => { const n = [...ch.querySelectorAll<HTMLInputElement>('input:checked')].map((x) => SECTIONS[+x.value]).join('、') || '（未选择）'; decide('needs_info', `要求补件：${n}`); });
  }, canReview);
  act('拒绝', 'btn-outline', () => dialog('确认拒绝', el('p', 'm0', `确认拒绝 ${a.company} 的申请？`), '拒绝', () => decide('rejected', '拒绝'), true), canReview);
  act('重新发送链接', 'btn-outline', () => { a.status = 'invited'; a.expiresAt = d(30); a.log.push(`${d(0)} 重新发送链接，旧链接已失效`); openDetail(a.id); toast('已重新发送（原型：未实际发送）'); }, ['invited', 'in_progress', 'expired', 'needs_info'].includes(a.status));
  act('删除申请', 'btn-outline', () => {
    const body = el('div', 'stack'); body.innerHTML = `<p class="m0">删除后，申请和全部文件都无法恢复。请输入编号 <b></b> 确认。</p><div class="f"><input aria-label="输入编号确认" /></div>`;
    body.querySelector('b')!.textContent = a.ref;
    dialog('删除申请', body, '永久删除', () => { if ((body.querySelector('input') as HTMLInputElement).value !== a.ref) { toast('编号不一致，未删除'); return; } apps.splice(apps.indexOf(a), 1); renderList(); showPanel('apps'); toast('已删除（原型）'); }, true);
  });
  const lg = el('div'); lg.appendChild(el('h3', 'm0', '操作记录'));
  const ul = el('ul', 'timeline-mini'); for (const x of a.log) ul.appendChild(el('li', '', x)); lg.appendChild(ul);
  side.appendChild(lg);
}
$('[data-back-list]').addEventListener('click', () => { renderList(); showPanel('apps'); });

// ---------- 启动 ----------
showView('login');
if (!PROTO) {
  // 正式模式的登录接口将在正式开发阶段接入
  const er = $('[data-login-err]'); er.textContent = '后台尚未启用。'; er.hidden = false;
}
