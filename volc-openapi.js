// 火山引擎 OpenAPI 通用 V4 签名 + 云解析DNS 自助登记
// 用途：容器位于火山引擎服务器内网，可直连 open.volcengineapi.com，
//      启动时用 AK/SK 为本应用域名自动创建 A 记录（解决 shenxin.versecraft.cn 无解析的问题）
const crypto = require("crypto");

function hmac(key, data) { return crypto.createHmac("sha256", key).update(data, "utf8").digest(); }
function sha256hex(d) { return crypto.createHash("sha256").update(d, "utf8").digest("hex"); }
function uriEncode(s) {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
function canonicalQuery(params) {
  return Object.keys(params).sort()
    .map((k) => uriEncode(k) + "=" + uriEncode(String(params[k]))).join("&");
}

// 调用一个火山引擎 OpenAPI 动作
async function volcRequest({ ak, sk, service, region, host = "open.volcengineapi.com", action, version, method = "POST", query = {}, body = null }) {
  const q = Object.assign({ Action: action, Version: version }, query);
  const cq = canonicalQuery(q);
  const now = new Date();
  const xDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const shortDate = xDate.slice(0, 8);
  const payload = body ? JSON.stringify(body) : "";
  const payloadHash = sha256hex(payload);
  const contentType = "application/json; charset=utf-8";
  const signedHeaders = "content-type;host;x-content-sha256;x-date";
  const canonicalHeaders =
    `content-type:${contentType}\nhost:${host}\nx-content-sha256:${payloadHash}\nx-date:${xDate}\n`;
  const canonicalRequest = [method, "/", cq, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ["HMAC-SHA256", xDate, credentialScope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac(sk, shortDate);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const authorization =
    `HMAC-SHA256 Credential=${ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `https://${host}/?${cq}`;
  const resp = await fetch(url, {
    method,
    headers: {
      "Content-Type": contentType, Host: host,
      "X-Date": xDate, "X-Content-Sha256": payloadHash, Authorization: authorization,
    },
    body: payload || undefined,
  });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = text; }
  return { status: resp.status, json };
}

// 启动时自助登记 DNS A 记录
async function selfRegisterDNS() {
  const ak = process.env.VOLC_AK, sk = process.env.VOLC_SK;
  const root = process.env.DNS_ROOT || "versecraft.cn";
  const hostName = process.env.DNS_HOST || "shenxin";
  const ip = process.env.DNS_TARGET_IP;
  const service = process.env.DNS_SERVICE || "DNS";
  const region = process.env.DNS_REGION || "cn-north-1";
  const version = process.env.DNS_VERSION || "2018-08-01";
  if (!ak || !sk || !ip) { console.log("[dns] skip: missing VOLC_AK/SK or DNS_TARGET_IP"); return; }
  console.log(`[dns] self-register ${hostName}.${root} -> ${ip} (svc=${service} region=${region} ver=${version})`);
  try {
    const lz = await volcRequest({ ak, sk, service, region, action: "ListZones", version, method: "GET", query: { Key: root, PageSize: 100, PageNumber: 1 } });
    console.log("[dns] ListZones", lz.status, JSON.stringify(lz.json).slice(0, 600));
    const zones = (lz.json && lz.json.Result && lz.json.Result.Zones) || [];
    const zone = zones.find((z) => z.ZoneName === root) || zones[0];
    if (!zone) { console.log("[dns] zone not found:", root); return; }
    const ZID = zone.ZID;
    const lr = await volcRequest({ ak, sk, service, region, action: "ListRecords", version, method: "GET", query: { ZID, Host: hostName, PageSize: 100, PageNumber: 1 } });
    console.log("[dns] ListRecords", lr.status, JSON.stringify(lr.json).slice(0, 500));
    const recs = (lr.json && lr.json.Result && lr.json.Result.Records) || [];
    const hit = recs.find((r) => (r.Host === hostName) && r.Type === "A");
    if (hit && hit.Value === ip) { console.log("[dns] record already correct, done"); return; }
    if (hit && hit.Value !== ip) {
      const ur = await volcRequest({ ak, sk, service, region, action: "UpdateRecord", version, method: "POST", body: { RecordID: hit.RecordID, Host: hostName, Type: "A", Value: ip, TTL: 600 } });
      console.log("[dns] UpdateRecord", ur.status, JSON.stringify(ur.json).slice(0, 500));
      return;
    }
    const cr = await volcRequest({ ak, sk, service, region, action: "CreateRecord", version, method: "POST", body: { ZID, Host: hostName, Type: "A", Value: ip, TTL: 600 } });
    console.log("[dns] CreateRecord", cr.status, JSON.stringify(cr.json).slice(0, 600));
  } catch (e) {
    console.log("[dns] error:", String(e));
  }
}

module.exports = { volcRequest, selfRegisterDNS };
