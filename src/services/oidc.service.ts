/**
 * OIDC 用户开通：按 IdP 的 sub 匹配/创建本地账户。
 *
 * 安全要点：
 *  - 匹配键是 oidc_sub（唯一索引），绝不是 username——按用户名关联会让
 *    任何持有同名 IdP 账号的人接管既有本地账户；
 *  - 新建用户：恒为 user 角色、active 状态、随机不可知本地密码（本地密
 *    码登录对 OIDC 账户不可用）、默认配额（与自助注册同一模板）；
 *  - register.mode 不 gate 本流程（IdP 已核验身份）；REGISTER_MODE 管的
 *    是匿名自助注册。
 */
import { randomBytes } from "node:crypto";
import type { Database } from "../db/driver.ts";
import type { OidcClaims } from "../auth/oidc.ts";
import { hashPassword } from "../auth/password.ts";
import { loadConfig } from "../config.ts";
import { toPublic, type UserRow, type UserPublic } from "./user.service.ts";
import { BadRequestError } from "../utils/errors.ts";

function sanitizeUsername(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return cleaned || `oidc-${randomBytes(4).toString("hex")}`;
}

function deriveUsername(claims: OidcClaims): string {
  if (claims.preferred_username) return sanitizeUsername(claims.preferred_username);
  if (claims.email?.includes("@")) return sanitizeUsername(claims.email.split("@")[0]);
  return `oidc-${claims.sub.slice(0, 12)}`;
}

export async function upsertOidcUser(db: Database, claims: OidcClaims): Promise<UserRow> {
  const existing = await db.get<UserRow>(
    "SELECT * FROM users WHERE oidc_subject = ?",
    claims.sub,
  );
  if (existing) {
    await db.run("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", existing.id);
    return existing;
  }

  const cfg = loadConfig();
  const base = deriveUsername(claims);
  let username = base;
  for (let attempt = 1; ; attempt += 1) {
    const taken = await db.get<{ id: number }>("SELECT id FROM users WHERE username = ?", username);
    if (!taken) break;
    username = `${base}-${attempt}`.slice(0, 63);
    if (attempt > 50) throw new BadRequestError("OIDC 用户名派生冲突过多");
  }

  const quota = await db.get<{ id: number }>(
    "SELECT id FROM resource_quotas WHERE name = ? ORDER BY id LIMIT 1",
    cfg.register.defaultQuotaName,
  );
  const fallback = quota
    ? undefined
    : await db.get<{ id: number }>("SELECT id FROM resource_quotas ORDER BY id LIMIT 1");

  // 随机本地密码：OIDC 账户不走密码登录；哈希只为满足 NOT NULL 约束。
  const unreachablePassword = randomBytes(32).toString("hex");
  const passwordHash = await hashPassword(unreachablePassword);
  const result = await db.run(
    `INSERT INTO users (username, password_hash, email, role, quota_id, status, must_change_password, auth_provider, oidc_subject)
     VALUES (?, ?, ?, 'user', ?, 'active', 0, 'oidc', ?)`,
    username,
    passwordHash,
    claims.email ?? null,
    quota?.id ?? fallback?.id ?? null,
    claims.sub,
  );
  const row = await db.get<UserRow>("SELECT * FROM users WHERE id = ?", Number(result.lastInsertRowid));
  if (!row) throw new Error("OIDC 用户创建后读取失败");
  return row;
}

export function oidcPublicUser(user: UserRow): UserPublic {
  return toPublic(user);
}
