// 深信服智能客服 · 零依赖 Node 服务
// - 提供静态页面 (public/index.html)
// - POST /api/chat 流式代理到火山引擎方舟 (Ark) 大模型
// - 未配置/调用失败时回退到本地知识库应答，保证演示始终可用
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

function send(res, code, type, body) {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

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

async function handleChat(req, res) {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    let messages = [];
    try {
      const body = JSON.parse(raw || "{}");
      messages = Array.isArray(body.messages) ? body.messages : [];
    } catch (e) {}
    const lastUser =
      [...messages].reverse().find((m) => m.role === "user")?.content || "";

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });

    const finish = () => {
      res.write(`data: [DONE]\n\n`);
      res.end();
    };
    const sendDelta = (txt) => {
      res.write(`data: ${JSON.stringify({ delta: txt })}\n\n`);
    };

    // 未配置任何凭证 → 本地回退（逐字输出，模拟打字）
    if (!HAS_LLM) {
      const ans = fallbackAnswer(lastUser);
      for (const ch of ans) {
        sendDelta(ch);
        await new Promise((r) => setTimeout(r, 12));
      }
      return finish();
    }

    try {
      const bodyStr = JSON.stringify({
        model: ARK_MODEL,
        stream: true,
        temperature: 0.6,
        messages: [
          { role: "system", content: KNOWLEDGE },
          ...messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .slice(-12),
        ],
      });
      const headers = ARK_API_KEY
        ? {
            "Content-Type": "application/json",
            Authorization: `Bearer ${ARK_API_KEY}`,
          }
        : signedArkHeaders(bodyStr);
      const upstream = await fetch(`${ARK_BASE_URL}/chat/completions`, {
        method: "POST",
        headers,
        body: bodyStr,
      });

      if (!upstream.ok || !upstream.body) {
        const errTxt = await upstream.text().catch(() => "");
        console.error("Ark error", upstream.status, errTxt.slice(0, 300));
        const ans = fallbackAnswer(lastUser);
        for (const ch of ans) {
          sendDelta(ch);
          await new Promise((r) => setTimeout(r, 10));
        }
        return finish();
      }

      // 转发上游 SSE，逐行解析 OpenAI 兼容格式
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          const s = line.trim();
          if (!s.startsWith("data:")) continue;
          const payload = s.slice(5).trim();
          if (payload === "[DONE]") continue;
          try {
            const j = JSON.parse(payload);
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) sendDelta(delta);
          } catch (e) {}
        }
      }
      finish();
    } catch (err) {
      console.error("chat fatal", err);
      const ans = fallbackAnswer(lastUser);
      for (const ch of ans) sendDelta(ch);
      finish();
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }
  const url = req.url.split("?")[0];
  if (url === "/healthz") return send(res, 200, "text/plain", "ok");
  if (url === "/api/config")
    return send(
      res,
      200,
      "application/json",
      JSON.stringify({ model: ARK_MODEL, llm: HAS_LLM })
    );
  if (url === "/api/chat" && req.method === "POST") return handleChat(req, res);
  if (url === "/" || url === "/index.html")
    return send(res, 200, "text/html; charset=utf-8", INDEX_HTML);
  send(res, 404, "text/plain", "Not Found");
});

server.listen(PORT, () => {
  const mode = ARK_API_KEY ? "apikey" : VOLC_AK ? "ak/sk" : "demo";
  console.log(`深信服智能客服 running on :${PORT}  (LLM=${HAS_LLM}, auth=${mode}, model=${ARK_MODEL})`);
  if (process.env.DNS_SELF_REGISTER === "1") {
    selfRegisterDNS().catch((e) => console.log("[dns] uncaught", String(e)));
  }
});
