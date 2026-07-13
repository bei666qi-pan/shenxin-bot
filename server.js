// 深信服智能客服 · 零依赖 Node 服务（加固版）
// - 提供静态页面 (public/index.html)
// - POST /api/chat 流式代理到火山引擎方舟 (Ark) 大模型
// - 未配置/调用失败时回退到本地知识库应答，保证演示始终可用
// - 安全加固：限流、请求体上限、输入校验、上游超时、断连中止、CORS 收紧、安全响应头
// 运行：node server.js   需要 Node 18+ (内置 fetch)

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { KNOWLEDGE } = require("./knowledge.js");
const { selfRegisterDNS } = require("./volc-openapi.js");

const PORT = process.env.PORT || 3000;

// 火山引擎方舟配置（部署时通过环境变量注入）
// 两种鉴权方式，二选一即可：
//   1) ARK_API_KEY  —— 方舟控制台创建的 API Key（Bearer）
//   2) VOLC_AK + VOLC_SK —— 访问密钥，使用火山引擎 V4 签名直接调用
const ARK_API_KEY = process.env.ARK_API_KEY || "";
const VOLC_AK = process.env.VOLC_AK || "";
const VOLC_SK = process.env.VOLC_SK || "";
const ARK_MODEL = process.env.ARK_MODEL || "doubao-seed-1-6-250615";
const ARK_BASE_URL =
  process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";
const ARK_REGION = process.env.ARK_REGION || "cn-beijing";
const HAS_LLM = !!(ARK_API_KEY || (VOLC_AK && VOLC_SK));

// ---- 可调参数（均可用环境变量覆盖）----
const MAX_TOKENS = parseInt(process.env.ARK_MAX_TOKENS || "1024", 10); // 单次回答 token 上限（成本保护）
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || "60000", 10); // 上游总超时
const MAX_BODY_BYTES = 64 * 1024;          // 请求体上限 64KB
const MAX_MSG_CHARS = 2000;                // 单条消息长度上限
const MAX_HISTORY = 12;                    // 携带历史条数上限
const MAX_HISTORY_CHARS = 12000;           // 历史总字符预算
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || "12", 10);      // 每 IP 每分钟请求数
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "8", 10); // 全局并发上游流上限
// CORS：默认不开放跨域（页面同源加载，无需 CORS）。需要被第三方站点嵌入时设置 ALLOWED_ORIGIN
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
const ANALYTICS_URL = process.env.ANALYTICS_URL || "";
const ANALYTICS_TOKEN = process.env.ANALYTICS_TOKEN || "";

function track(req, event) {
  if (!ANALYTICS_URL || !ANALYTICS_TOKEN) return;
  const forwarded = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
  fetch(`${ANALYTICS_URL.replace(/\/$/, "")}/api/collect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANALYTICS_TOKEN}`, "X-Forwarded-For": String(forwarded).split(",")[0] },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(2500),
  }).catch(() => {});
}

// ---- 火山引擎 V4 签名（AK/SK 直连，无需控制台 API Key）----
function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}
function sha256hex(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}
function signedArkHeaders(bodyStr) {
  const url = new URL(`${ARK_BASE_URL}/chat/completions`);
  const host = url.host;
  const canonicalURI = url.pathname;
  const now = new Date();
  const xDate =
    now.toISOString().replace(/[:-]|\.\d{3}/g, "").replace(/\.\d+/, "");
  // -> YYYYMMDDTHHMMSSZ
  const shortDate = xDate.slice(0, 8);
  const service = "ark";
  const payloadHash = sha256hex(bodyStr);
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const canonicalHeaders =
    `content-type:application/json\n` +
    `host:${host}\n` +
    `x-content-sha256:${payloadHash}\n` +
    `x-date:${xDate}\n`;
  const canonicalRequest = [
    "POST",
    canonicalURI,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${shortDate}/${ARK_REGION}/${service}/request`;
  const stringToSign = [
    "HMAC-SHA256",
    xDate,
    credentialScope,
    sha256hex(canonicalRequest),
  ].join("\n");
  const kDate = hmac(VOLC_SK, shortDate);
  const kRegion = hmac(kDate, ARK_REGION);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "request");
  const signature = crypto
    .createHmac("sha256", kSigning)
    .update(stringToSign, "utf8")
    .digest("hex");
  const authorization =
    `HMAC-SHA256 Credential=${VOLC_AK}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    "Content-Type": "application/json",
    Host: host,
    "X-Date": xDate,
    "X-Content-Sha256": payloadHash,
    Authorization: authorization,
  };
}

const INDEX_HTML = fs.readFileSync(
  path.join(__dirname, "public", "index.html"),
  "utf8"
);
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><defs><linearGradient id="g" x1="0" y1="0" x2="48" y2="48"><stop offset="0" stop-color="#36d1dc"/><stop offset="1" stop-color="#1763E6"/></linearGradient></defs><path d="M24 3l16 6v11c0 11-6.9 19.4-16 25C14.9 39.4 8 31 8 20V9l16-6z" fill="url(#g)"/><path d="M17 24l5 5 9-10" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

// ---- 安全响应头 ----
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
const HTML_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";

function corsHeaders(req) {
  if (!ALLOWED_ORIGIN) return {};
  const origin = req.headers.origin;
  if (!origin) return {};
  if (ALLOWED_ORIGIN === "*" || origin === ALLOWED_ORIGIN)
    return { "Access-Control-Allow-Origin": ALLOWED_ORIGIN === "*" ? "*" : origin, Vary: "Origin" };
  return {};
}

function send(res, code, type, body, extra = {}) {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
    ...extra,
  });
  res.end(body);
}

// ---- 客户端 IP（兼容 Coolify/Traefik 反代）----
function clientIP(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length)
    return xff.split(",")[0].trim().slice(0, 64);
  return req.socket.remoteAddress || "unknown";
}

// ---- 简易滑动窗口限流（每 IP 每分钟 RATE_LIMIT 次）----
const rateMap = new Map(); // ip -> { count, resetAt }
function rateLimited(ip) {
  const now = Date.now();
  let e = rateMap.get(ip);
  if (!e || now >= e.resetAt) {
    e = { count: 0, resetAt: now + 60_000 };
    rateMap.set(ip, e);
  }
  e.count++;
  return e.count > RATE_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateMap) if (now >= e.resetAt) rateMap.delete(ip);
}, 60_000).unref();

let activeStreams = 0; // 全局并发计数

// ---- 本地回退应答（无大模型 / 调用失败时使用）----
function fallbackAnswer(q) {
  const t = (q || "").toLowerCase();
  const has = (...ks) => ks.some((k) => (q || "").includes(k) || t.includes(k));
  if (has("安全gpt", "securitygpt", "大模型", "gpt"))
    return "安全 GPT 是深信服面向安全垂直领域的大模型，已迭代至 4.0，覆盖**钓鱼检测、Web 检测、安全运营**三大场景。钓鱼检测检出率超 95%、误报率约 0.15%；XDR+安全 GPT 可实现约 30 秒研判、把 3–6 小时的处置闭环缩短到 5–10 分钟。目前已在 500+ 客户真实环境落地。需要深入了解可拨打售前热线 400-806-6868。";
  if (has("信服云", "超融合", "hci", "桌面云", "adesk", "云计算", "存储", "eds"))
    return "信服云是深信服的云计算品牌，核心产品包括**超融合 HCI、云平台 SCP、企业级分布式存储 EDS、桌面云 aDesk（VDI）**，以及托管云、私有云、混合云方案，覆盖「云-网-边-端」。想了解适合您的方案，欢迎拨打 400-806-6868。";
  if (has("防火墙", "edr", "终端", "aes", "上网行为", "ac", "零信任", "atrust", "xdr", "sase", "网络安全", "安全"))
    return "深信服智安全产品线包括：**下一代防火墙 AF、统一端点安全管理 aES(EDR)、上网行为管理 AC、零信任 aTrust、安全感知平台 SIP、XDR、SASE、MDR/MSS 安全托管**等。请问您关注哪一类场景？也可拨打售前热线 400-806-6868。";
  if (has("电话", "热线", "联系", "客服", "售后", "支持", "邮箱"))
    return "深信服服务方式：\n- 售后技术支持：**400-630-6430**（7×24）\n- 售前/项目咨询：**400-806-6868**\n- 邮箱：support@sangfor.com.cn\n- 技术支持中心：support.sangfor.com.cn";
  if (has("公司", "简介", "概况", "介绍", "上市", "股票", "成立"))
    return "深信服科技（Sangfor，**300454**）成立于 2000 年，总部深圳，员工约 7000+，服务全球 70 多个国家和地区、超 10 万家企业级用户。使命是「让每个用户的数字化更简单、更安全」，业务覆盖**网络安全、云计算、AI**三大板块。";
  return "您好，我是深信服智能客服 🛡️。我可以帮您了解深信服的**网络安全、信服云、安全 GPT** 等产品与服务。请问您想咨询哪方面？也可直接拨打售前热线 400-806-6868。";
}

// ---- 转人工意图（无需消耗大模型，直接给联系方式）----
const HUMAN_RE = /转人工|人工客服|真人客服|人工服务|找人工|要人工|接人工|联系销售|商务对接/;
function humanHandoffAnswer() {
  return "好的，马上为您对接人工服务 🤝\n\n- **售前 / 方案与报价咨询**：400-806-6868（工作时间优先接通）\n- **售后 / 技术支持**：400-630-6430（7×24 全年无休）\n- **邮箱**：support@sangfor.com.cn\n- **技术支持中心**：support.sangfor.com.cn\n\n您也可以把**公司名称 + 联系方式 + 需求**发给我，我会记录并提示您由专人回电跟进。";
}

// ---- 输入校验与裁剪 ----
function sanitizeMessages(input) {
  if (!Array.isArray(input)) return [];
  const cleaned = [];
  for (const m of input) {
    if (!m || typeof m !== "object") continue;
    if (m.role !== "user" && m.role !== "assistant") continue; // 拒绝注入 system
    if (typeof m.content !== "string") continue;               // 拒绝非字符串(多模态)注入
    const content = m.content.trim().slice(0, MAX_MSG_CHARS);
    if (!content) continue;
    cleaned.push({ role: m.role, content });
  }
  // 取最近 MAX_HISTORY 条，且总字符不超预算（从最新往前累计）
  const recent = cleaned.slice(-MAX_HISTORY);
  let budget = MAX_HISTORY_CHARS;
  const out = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    budget -= recent[i].content.length;
    if (budget < 0 && out.length) break;
    out.unshift(recent[i]);
  }
  return out;
}

// ---- 读取请求体（带大小上限）----
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        req.pause(); // 停止继续读，让上层先回 413 再断开
        reject(Object.assign(new Error("payload too large"), { code: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---- 调用上游（带超时；429/5xx/网络错误自动重试一次）----
async function callArk(bodyStr, signal) {
  const headers = ARK_API_KEY
    ? { "Content-Type": "application/json", Authorization: `Bearer ${ARK_API_KEY}` }
    : signedArkHeaders(bodyStr);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 + Math.random() * 400));
    try {
      const resp = await fetch(`${ARK_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: ARK_API_KEY ? headers : signedArkHeaders(bodyStr), // AK/SK 签名含时间戳，重试需重签
        body: bodyStr,
        signal,
      });
      if (resp.ok && resp.body) return resp;
      const errTxt = await resp.text().catch(() => "");
      lastErr = new Error(`ark ${resp.status}: ${errTxt.slice(0, 300)}`);
      // 仅对可重试错误继续循环
      if (![429, 500, 502, 503, 504].includes(resp.status)) break;
    } catch (e) {
      if (signal?.aborted) throw e; // 客户端断开/超时，不再重试
      lastErr = e;
    }
  }
  throw lastErr || new Error("ark call failed");
}

async function handleChat(req, res) {
  const ip = clientIP(req);
  const reqId = crypto.randomBytes(4).toString("hex");
  const t0 = Date.now();

  // 1) 限流（在建立 SSE 之前用标准状态码返回）
  if (rateLimited(ip))
    return send(res, 429, "application/json", JSON.stringify({ error: "请求过于频繁，请稍后再试" }), corsHeaders(req));
  if (activeStreams >= MAX_CONCURRENT)
    return send(res, 503, "application/json", JSON.stringify({ error: "当前咨询人数较多，请稍后再试" }), corsHeaders(req));

  // 2) 读取与校验请求体
  let raw = "";
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (e) {
    const code = e.code === 413 ? 413 : 400;
    if (code === 413) res.on("finish", () => req.destroy()); // 响应送达后断开，防止继续灌数据
    return send(res, code, "application/json", JSON.stringify({ error: "请求体无效或过大" }), corsHeaders(req));
  }
  let messages = [];
  try {
    const body = JSON.parse(raw || "{}");
    messages = sanitizeMessages(body.messages);
  } catch (e) {
    return send(res, 400, "application/json", JSON.stringify({ error: "JSON 解析失败" }), corsHeaders(req));
  }
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  if (!lastUser)
    return send(res, 400, "application/json", JSON.stringify({ error: "缺少用户消息" }), corsHeaders(req));

  // 3) 建立 SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    ...SECURITY_HEADERS,
    ...corsHeaders(req),
  });
  res.write(`: connected\n\n`); // 立即冲洗，避免代理缓冲

  let closed = false;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error("upstream timeout")), UPSTREAM_TIMEOUT_MS);
  res.on("close", () => {
    closed = true;
    clearTimeout(timeout);
    abort.abort(new Error("client disconnected")); // 客户端断开 → 立刻中止上游，停止计费
  });

  const finish = () => {
    clearTimeout(timeout);
    if (closed || res.writableEnded) return;
    res.write(`data: [DONE]\n\n`);
    res.end();
  };
  const sendDelta = (txt) => {
    if (closed || res.writableEnded) return false;
    return res.write(`data: ${JSON.stringify({ delta: txt })}\n\n`);
  };
  const typeOut = async (text, delay = 10) => {
    for (const ch of text) {
      if (closed) return;
      sendDelta(ch);
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
  };
  const log = (status, extra = "") =>
    console.log(`[chat] id=${reqId} ip=${ip} ${status} ${Date.now() - t0}ms ${extra}`);

  // 4) 转人工意图：本地直答，不消耗大模型
  if (HUMAN_RE.test(lastUser)) {
    await typeOut(humanHandoffAnswer(), 6);
    log("handoff");
    track(req, { type: "chat", status: "handoff", duration: Date.now() - t0 });
    return finish();
  }

  // 5) 未配置任何凭证 → 本地回退（逐字输出，模拟打字）
  if (!HAS_LLM) {
    await typeOut(fallbackAnswer(lastUser), 12);
    log("demo");
    track(req, { type: "chat", status: "demo", duration: Date.now() - t0 });
    return finish();
  }

  // 6) 调用大模型并转发流
  activeStreams++;
  try {
    const bodyStr = JSON.stringify({
      model: ARK_MODEL,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.6,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "system", content: KNOWLEDGE }, ...messages],
    });
    const upstream = await callArk(bodyStr, abort.signal);

    // 转发上游 SSE，逐行解析 OpenAI 兼容格式
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let usage = null;
    let outChars = 0;
    const handleLine = (line) => {
      const s = line.trim();
      if (!s.startsWith("data:")) return;
      const payload = s.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const j = JSON.parse(payload);
        if (j.usage) usage = j.usage;
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) {
          outChars += delta.length;
          sendDelta(delta);
        }
      } catch (e) {}
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (closed) {
        reader.cancel().catch(() => {});
        break;
      }
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) handleLine(line);
    }
    buf += decoder.decode(); // 冲洗解码器残留
    if (buf) handleLine(buf);
    log("ok", usage ? `tokens=${usage.prompt_tokens}+${usage.completion_tokens} out=${outChars}ch` : `out=${outChars}ch`);
    track(req, { type: "chat", status: "ok", duration: Date.now() - t0 });
    finish();
  } catch (err) {
    if (closed) {
      log("client-abort");
    } else {
      console.error(`[chat] id=${reqId} upstream error:`, String(err).slice(0, 300));
      await typeOut(fallbackAnswer(lastUser), 8);
      log("fallback");
      track(req, { type: "chat", status: "fallback", duration: Date.now() - t0 });
      finish();
    }
  } finally {
    activeStreams--;
    clearTimeout(timeout);
  }
}

const server = http.createServer((req, res) => {
  req.on("error", () => {});
  res.on("error", () => {});
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...corsHeaders(req),
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }
  const url = req.url.split("?")[0];
  if (url === "/healthz") return send(res, 200, "text/plain", "ok");
  if (url === "/favicon.svg" || url === "/favicon.ico")
    return send(res, 200, "image/svg+xml", FAVICON_SVG, { "Cache-Control": "public, max-age=86400" });
  if (url === "/api/config")
    return send(res, 200, "application/json", JSON.stringify({ llm: HAS_LLM }), corsHeaders(req));
  if (url === "/api/chat" && req.method === "POST")
    return handleChat(req, res).catch((e) => {
      console.error("chat fatal", e);
      if (!res.writableEnded) res.end();
    });
  if (url === "/" || url === "/index.html") {
    const referer = req.headers.referer || "";
    let source = "直接访问";
    try { if (referer) source = new URL(referer).hostname || "直接访问"; } catch (_) {}
    track(req, { type: "page_view", source });
    return send(res, 200, "text/html; charset=utf-8", INDEX_HTML, { "Content-Security-Policy": HTML_CSP });
  }
  send(res, 404, "text/plain", "Not Found");
});

// 防止单连接长期占用
server.requestTimeout = 0; // SSE 长连接，由业务层超时控制
server.headersTimeout = 30_000;

server.listen(PORT, () => {
  const mode = ARK_API_KEY ? "apikey" : VOLC_AK ? "ak/sk" : "demo";
  console.log(`深信服智能客服 running on :${PORT}  (LLM=${HAS_LLM}, auth=${mode}, model=${ARK_MODEL}, rate=${RATE_LIMIT}/min, max_tokens=${MAX_TOKENS})`);
  if (process.env.DNS_SELF_REGISTER === "1") {
    selfRegisterDNS().catch((e) => console.log("[dns] uncaught", String(e)));
  }
});

// ---- 优雅停机（Coolify 滚动发布时不掐断进行中的回答）----
function shutdown(sig) {
  console.log(`[shutdown] ${sig} received, closing...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref(); // 最多等 8s
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
