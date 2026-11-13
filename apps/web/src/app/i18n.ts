export type Locale = "en" | "zh-CN";

const en = {
  "login.eyebrow": "Your workspace awaits",
  "login.title": "Sign in to ARTOO",
  "login.lede": "Bring your agents together and pick up where you left off.",
  "login.submit": "Sign in with Google",
  "login.foot": "You'll be redirected to Google to authorize, then returned to ARTOO.",
  "errorBoundary.title": "Something went wrong loading this page.",
  "errorBoundary.tryAgain": "Try again",
  "errorBoundary.reload": "Reload",
} as const;

export type TranslationKey = keyof typeof en;

const zhCN: Record<TranslationKey, string> = {
  "login.eyebrow": "进入你的工作区",
  "login.title": "登录 ARTOO",
  "login.lede": "汇聚你的智能体团队，随时继续之前的工作。",
  "login.submit": "使用 Google 登录",
  "login.foot": "你将跳转至 Google 完成授权，随后返回 ARTOO。",
  "errorBoundary.title": "加载此页面时出错。",
  "errorBoundary.tryAgain": "重试",
  "errorBoundary.reload": "刷新页面",
};

const dictionaries: Record<Locale, Record<TranslationKey, string>> = {
  en,
  "zh-CN": zhCN,
};

let currentLocale: Locale = "en";

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function t(key: TranslationKey, locale: Locale = currentLocale): string {
  return dictionaries[locale]?.[key] ?? en[key];
}
