import copy from '../i18n/onboarding.json';
import type { Lang } from './i18n';

export type OCopy = typeof copy.en;
export const o = (lang: Lang): OCopy => copy[lang];
export const onboardingHref = (lang: Lang) => (lang === 'en' ? '/onboarding/' : '/zh/onboarding/');

/** 证明文件清单（原表附录 A）。company = 企业文件（required 表示必传）；person = 按人员角色上传 */
export const COMPANY_DOCS = [
  { id: 'd1', required: true }, { id: 'd2', required: true }, { id: 'd3', required: true },
  { id: 'd4', required: true }, { id: 'd5', required: true }, { id: 'd6', required: true },
  // v4：删除第 11、12 项（资金来源类证明，新版表单已删除资金来源问题）
  { id: 'd10', required: false },
  { id: 'd13', required: false }, { id: 'd14', required: false }, { id: 'd15', required: false },
  { id: 'd16', required: false },
] as const;
export const PERSON_DOCS = ['passport', 'poa'] as const;
export const ACCEPT = 'application/pdf,image/jpeg,image/png';
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
