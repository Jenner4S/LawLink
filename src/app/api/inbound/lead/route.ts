import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { createInboundLead } from "@/server/inbound/create-inbound-lead";

/**
 * 官网 / 公众号 / 落地页的线索入站接口（2026-11-23）
 *
 * ## 为什么要有
 *
 * 之前官网表单来的线索只能手工抄进系统——这是"获客"环节最后一处断点。
 * 有了这个接口，业主把表单的提交地址指过来就能自动落库，**不需要先在系统里点任何东西**。
 *
 * ## 鉴权
 *
 * 用 `INBOUND_LEAD_TOKEN`（环境变量）配一个随机串，表单侧以 `x-inbound-token` 头带上。
 * · 未配置 token → **503**，并明确告知怎么配（不静默放行：那等于公网任何人可造线索）
 * · 比较用 `timingSafeEqual`（避免按字节比较泄时序）
 *
 * ## 幂等
 *
 * 按 `externalId`（表单侧自己的提交 id）判重：同一个 id 重复提交 → 返回已有线索，不新建。
 * **没有 externalId 就不猜重复**——按"同手机号 24 小时内"去重会吞掉真实重复咨询
 * （同一个客户上午问一次、下午再问一次是两件事）。这条取舍写在下面代码里。
 *
 * ## 限流
 *
 * 单实例内存令牌桶（每 IP 60 次/分钟）。多副本部署时窗口各自计算，
 * 属于"够用就好"的取舍——真正的抗刷要靠 WAF 或网关，不是靠应用层。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  name: z.string().trim().min(1, "姓名不能为空").max(40),
  phone: z
    .string()
    .trim()
    .regex(/^1[3-9]\d{9}$/, "手机号格式不正确")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  /** 渠道名（如「大众点评」）：按名匹配已启用渠道，匹配不到就不挂渠道，不因此拒单 */
  channelName: z.string().trim().max(40).optional(),
  /** 表单侧的提交 id，用于幂等 */
  externalId: z.string().trim().max(80).optional(),
  /** 客户自己写的话，落到 notes */
  message: z.string().trim().max(1000).optional(),
  /** 来源页地址，落到 sourceDetail */
  pageUrl: z.string().trim().max(300).optional()
});

/** 单实例限流：IP → 最近一分钟的请求时间戳 */
const buckets = new Map<string, number[]>();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function rateLimited(ip: string, now = Date.now()): boolean {
  const hits = (buckets.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  buckets.set(ip, hits);
  // 顺手清理，避免长期运行把 Map 撑大
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (v.every((t) => now - t > RATE_WINDOW_MS)) buckets.delete(k);
  }
  return hits.length > RATE_LIMIT;
}

function tokenOk(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}


export async function POST(req: Request) {
  const expected = process.env.INBOUND_LEAD_TOKEN?.trim();
  if (!expected) {
    return NextResponse.json(
      {
        error: "入站接口未启用",
        howTo: "在 .env 设置 INBOUND_LEAD_TOKEN=<一段随机串>，并在表单侧用 x-inbound-token 头带上同一个值"
      },
      { status: 503 }
    );
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) {
    return NextResponse.json({ error: "请求过于频繁" }, { status: 429 });
  }

  if (!tokenOk(req.headers.get("x-inbound-token"), expected)) {
    return NextResponse.json({ error: "token 不正确" }, { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体必须是 JSON" }, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "字段校验失败", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      { status: 400 }
    );
  }
  const data = parsed.data;

  // 幂等与落库都在 createInboundLead 里（官网表单与邮件收件共用同一套口径，
  // 两处各写一遍必然分叉）
  const result = await createInboundLead({
    name: data.name,
    phone: data.phone ?? null,
    channelName: data.channelName ?? null,
    externalId: data.externalId ?? null,
    message: data.message ?? null,
    sourceDetail: data.pageUrl ?? null,
    activityNote: "官网表单提交（自动入站）"
  });

  if (!result.ok) {
    return NextResponse.json({ error: "没有可用的入站接收人", howTo: result.howTo }, { status: 503 });
  }
  if (result.duplicate) {
    return NextResponse.json({ ok: true, id: result.id, duplicate: true });
  }
  return NextResponse.json({ ok: true, id: result.id, duplicate: false }, { status: 201 });
}
