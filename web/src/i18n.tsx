/**
 * 管理控制台轻量 i18n：中文为默认语言（目标用户），英文通过词典映射。
 * 模式与 pi-web 一致——「英文即 key」（控制台存量文案为英文），
 * zh 词典给出中文；缺失时回退 key 本身（英文），渐进补齐。
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";

export type Lang = "zh" | "en";

const STORAGE_KEY = "amedac-console-lang";

/** zh 语言包：key 为控制台英文原文，value 为中文。按页面分块维护。 */
export const zhMessages: Record<string, string> = {
  // 导航 / 框架
  "Dashboard": "总览",
  "Containers": "容器",
  "Workspaces": "云盘",
  "Images": "镜像",
  "Logs": "日志",
  "LLM keys": "LLM 密钥",
  "Users": "用户",
  "Quotas": "配额",
  "LLM": "LLM 管理",
  "Administration": "管理",
  "Log out": "退出登录",
  "My API keys": "我的 API 密钥",
  "Sandbox Platform": "沙盒管理台",
  // 通用
  "Create": "创建",
  "Save": "保存",
  "Saving…": "保存中…",
  "Cancel": "取消",
  "Close": "关闭",
  "Delete": "删除",
  "Edit": "编辑",
  "Loading…": "加载中…",
  "Actions": "操作",
  "Name": "名称",
  "Status": "状态",
  "Confirm": "确认",
  // 容器页
  "ID": "ID",
  "Owner": "属主",
  "Resources": "规格",
  "Created": "创建时间",
  "All statuses": "全部状态",
  "running": "运行中",
  "stopped": "已停止",
  "creating": "创建中",
  "error": "错误",
  "destroyed": "已销毁",
  "No containers.": "暂无容器。",
  "Stop": "停止",
  "Destroy": "销毁",
  // 镜像页
  "Display name": "显示名",
  "Public": "公开",
  "Tags": "标签",
  "Default resources": "默认规格",
  "Per-user instance cap": "每人实例上限",
  "+ New image": "+ 新建镜像",
  "No images.": "暂无镜像。",
  "yes": "是",
  "no": "否",
  // 登录页
  "Sign in": "登录",
  "Username": "用户名",
  "Password": "密码",
  "Language": "语言",
};

interface LangContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string) => string;
}

const LangContext = createContext<LangContextValue | null>(null);

export function ConsoleLangProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === "zh" || saved === "en") return saved;
    } catch { /* private mode */ }
    return "zh";
  });

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch { /* ignore */ }
  }, [lang]);

  const value = useMemo<LangContextValue>(() => ({
    lang,
    setLang: setLangState,
    t: (key: string) => (lang === "zh" ? zhMessages[key] ?? key : key),
  }), [lang]);

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useConsoleLang(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) throw new Error("useConsoleLang must be used inside ConsoleLangProvider");
  return ctx;
}
