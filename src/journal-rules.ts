import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * 自動仕訳ルールAPI（2026-10-20 リリース。GET/POST/PUT/DELETE /api/v3/journal_rules）。
 * 対象は「連携サービスから入力（通帳・カード他）」のルールだけ。
 * POST/PUT/DELETE は1件でも失敗すると全件が不成立（部分成功は無い）。
 * PUT は全置換：省略したフィールドは null で上書きされる。
 */

type Call = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { query?: Record<string, unknown>; body?: unknown; officeCode?: string }
) => Promise<string>;

const SIDE_KEYS = [
  "account_id",
  "sub_account_id",
  "tax_id",
  "department_id",
  "trade_partner_code",
  "value",
  "value_type",
  "invoice_kind",
] as const;

function side(s: Record<string, unknown> | null | undefined) {
  if (!s) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of SIDE_KEYS) if (s[k] !== undefined) out[k] = s[k];
  // value は FIXED_AMOUNT のときだけ送れる（それ以外で値があると 400）
  if (out.value_type !== "FIXED_AMOUNT") delete out.value;
  return out;
}

/**
 * GET の形（*_name 付き・null 埋め）を、POST/PUT で送れる形に直す。
 * PUT は省略したフィールドを null で上書きするので、GET で読んだ値は全部送り直す。
 */
export function toWritableRule(r: Record<string, any>, withId: boolean) {
  const out: Record<string, unknown> = {};
  if (withId) out.id = r.id;
  for (const k of ["connected_account_id", "connected_sub_account_id", "side", "is_auto_registration"]) {
    if (r[k] !== undefined && r[k] !== null) out[k] = r[k];
  }
  // PUT で省略すると null 上書きになるので、今の値をそのまま送る（この値は変更できない）
  out.is_fallback_rule = Boolean(r.is_fallback_rule);
  if (!r.is_fallback_rule) {
    // 「どのルールにもマッチしなかった場合」のルールは content・一致条件・金額条件・優先度を送らない
    for (const k of ["content", "condition_content_match_type", "value_min", "value_max", "priority"]) {
      if (r[k] !== undefined && r[k] !== null) out[k] = r[k];
    }
  }
  const t = r.journal_template ?? {};
  out.journal_template = {
    ...(t.tags !== undefined ? { tags: t.tags ?? [] } : {}),
    branches: (t.branches ?? []).map((b: Record<string, any>) => {
      const o: Record<string, unknown> = { remark: b.remark ?? null };
      const d = side(b.debitor);
      const c = side(b.creditor);
      if (d && d.account_id) o.debitor = d;
      if (c && c.account_id) o.creditor = c;
      return o;
    }),
  };
  return out;
}

export function registerJournalRuleTools(
  server: McpServer,
  call: Call,
  officeParam: Record<string, z.ZodTypeAny>
) {
  const office = (a: Record<string, unknown>) => a.office_code as string | undefined;

  server.tool(
    "mfc_ca_getJournalRules",
    "自動仕訳ルール（通帳・カード他。単一・複合）の一覧を取得します。複合ルールは journal_template.branches に複数行。all_pages=true で全ページをまとめて返します（1ページ最大200件）。",
    {
      ...officeParam,
      connected_account_id: z.string().optional().describe("連携サービスID（connected_sub_account_id と同時指定不可）"),
      connected_sub_account_id: z.string().optional().describe("口座ID（connected_account_id と同時指定不可）"),
      side: z.enum(["INCOME", "EXPENSE"]).optional(),
      content: z.string().max(200).optional().describe("明細の内容で絞り込む（摘要は対象外）"),
      content_match_type: z.enum(["exact", "partial", "forward", "backward"]).optional().describe("content の一致条件（既定 partial）"),
      page: z.number().int().min(1).optional(),
      per_page: z.number().int().min(1).max(200).optional().describe("既定10・最大200"),
      all_pages: z.boolean().optional().describe("true なら per_page=200 で最後のページまで取得して結合する"),
    },
    async (args) => {
      try {
        const { all_pages, office_code: _oc, ...q } = args as Record<string, any>;
        if (!all_pages) return text(await call("GET", "/journal_rules", { query: q, officeCode: office(args) }));
        const rules: unknown[] = [];
        let total: unknown = null;
        for (let page = 1; ; page++) {
          const r = JSON.parse(await call("GET", "/journal_rules", { query: { ...q, page, per_page: 200 }, officeCode: office(args) }));
          rules.push(...(r.journal_rules ?? []));
          total = r.metadata?.total_count ?? total;
          const pages = r.metadata?.total_pages ?? 1;
          if (page >= pages || !(r.journal_rules ?? []).length) break;
        }
        return text({ journal_rules: rules, metadata: { total_count: total, fetched: rules.length } });
      } catch (e) {
        return errText(e);
      }
    }
  );

  const ruleArray = z
    .array(z.record(z.any()))
    .min(1)
    .describe(
      "ルールの配列。GET の結果をそのまま渡してよい（*_name・null は送れる形に直す）。branches は借方行・貸方行がそれぞれ1行以上・最大300行。account_id と tax_id は必須。value は value_type=FIXED_AMOUNT のときだけ"
    );

  server.tool(
    "mfc_ca_postJournalRules",
    "自動仕訳ルールを作成します（MFの設定の書き込み。要ユーザー承認）。1件でも失敗すると全件作成されません。priority の既定は100。",
    { ...officeParam, journal_rules: ruleArray },
    async (args) => {
      try {
        const rules = (args.journal_rules as Record<string, any>[]).map((r) => toWritableRule(r, false));
        return text(await call("POST", "/journal_rules", { body: { journal_rules: rules }, officeCode: office(args) }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    "mfc_ca_putJournalRules",
    "自動仕訳ルールを更新します（全置換・MFの設定の書き込み。要ユーザー承認）。省略したフィールドは null で上書きされるので、必ず mfc_ca_getJournalRules で今のルールを読み、変える所だけ直して全項目を送る。is_fallback_rule は変更できない。1件でも失敗すると全件変更されません。",
    { ...officeParam, journal_rules: ruleArray.describe("id 必須。GET の結果を直して渡す") },
    async (args) => {
      try {
        const rules = (args.journal_rules as Record<string, any>[]).map((r) => {
          if (!r.id) throw new Error("更新するルールに id がありません");
          return toWritableRule(r, true);
        });
        return text(await call("PUT", "/journal_rules", { body: { journal_rules: rules }, officeCode: office(args) }));
      } catch (e) {
        return errText(e);
      }
    }
  );

  server.tool(
    "mfc_ca_deleteJournalRules",
    "自動仕訳ルールを削除します（MFの設定の書き込み。要ユーザー承認）。1件でも失敗すると全件削除されません。消す前に GET の結果を控えておく。",
    { ...officeParam, ids: z.array(z.string()).min(1).describe("ルールID（GET が返した値のまま）") },
    async (args) => {
      try {
        return text(await call("DELETE", "/journal_rules", { body: { ids: args.ids }, officeCode: office(args) }));
      } catch (e) {
        return errText(e);
      }
    }
  );
}

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: typeof payload === "string" ? payload : JSON.stringify(payload) }] };
}

function errText(e: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true,
  };
}
