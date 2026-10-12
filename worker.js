// 버스 승차 알림 백엔드 (Cloudflare Workers + D1)

// 정류장 목록. QR의 ?station=값 과 일치해야 합니다.
// cityCode / nodeId 는 공공데이터포털(TAGO) 정류장 정보에서 확인.
const STATIONS = {
  "DEMO-001": { name: "시청앞 정류장", lat: 37.5663, lng: 126.9779 },
  "12345":    { name: "예시 정류장",   lat: 37.5665, lng: 126.9780, cityCode: "11", nodeId: "SEL00000" },
};

const TTL_SEC = 180;      // 요청 유지 시간(3분)
const RATE_LIMIT = 5;     // 같은 IP가 1분에 보낼 수 있는 요청 수

const DEMO_BUSES = [
  { no: "143", eta: 2 }, { no: "401", eta: 5 },
  { no: "9407", eta: 9 }, { no: "472", eta: 14 },
];

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}
const send = (env, data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(env) },
  });

// 도착 예정 버스 조회 (TAGO 키가 없으면 데모 데이터)
async function getBuses(env, st) {
  if (!env.TAGO_KEY || !st.nodeId) return DEMO_BUSES;
  const url =
    "https://apis.data.go.kr/1613000/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList" +
    `?serviceKey=${encodeURIComponent(env.TAGO_KEY)}&cityCode=${st.cityCode}` +
    `&nodeId=${st.nodeId}&numOfRows=20&_type=json`;
  const res = await fetch(url);
  const data = await res.json();
  let items = data?.response?.body?.items?.item || [];
  if (!Array.isArray(items)) items = [items];
  return items
    .map((i) => ({ no: String(i.routeno), eta: Math.max(0, Math.round(i.arrtime / 60)) }))
    .sort((a, b) => a.eta - b.eta);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const now = Math.floor(Date.now() / 1000);

    if (req.method === "OPTIONS") return new Response(null, { headers: cors(env) });

    try {
      // 1) 정류장 정보 + 버스 목록 (앱)
      let m = path.match(/^\/stations\/([^/]+)$/);
      if (m && req.method === "GET") {
        const id = decodeURIComponent(m[1]);
        const st = STATIONS[id];
        if (!st) return send(env, { error: "없는 정류장" }, 404);
        const buses = await getBuses(env, st);
        return send(env, { station: { id, name: st.name, lat: st.lat, lng: st.lng }, buses });
      }

      // 2) 승차 요청 (앱)
      if (path === "/requests" && req.method === "POST") {
        const { stationId, busNo } = await req.json();
        if (!STATIONS[stationId] || !/^[0-9A-Za-z-]{1,10}$/.test(String(busNo)))
          return send(env, { error: "잘못된 요청" }, 400);

        const ip = req.headers.get("CF-Connecting-IP") || "unknown";
        await env.DB.prepare("DELETE FROM requests WHERE expires_at < ?").bind(now).run();
        const recent = await env.DB
          .prepare("SELECT COUNT(*) AS c FROM requests WHERE ip = ? AND created_at > ?")
          .bind(ip, now - 60).first();
        if (recent.c >= RATE_LIMIT) return send(env, { error: "잠시 후 다시 시도하세요" }, 429);

        const requestId = crypto.randomUUID();
        await env.DB
          .prepare("INSERT INTO requests VALUES (?,?,?,?,?,?)")
          .bind(requestId, stationId, String(busNo), ip, now, now + TTL_SEC).run();
        return send(env, { ok: true, requestId });
      }

      // 3) 요청 취소 (앱)
      m = path.match(/^\/requests\/([^/]+)$/);
      if (m && req.method === "DELETE") {
        await env.DB.prepare("DELETE FROM requests WHERE id = ?").bind(m[1]).run();
        return send(env, { ok: true });
      }

      // 4) 라즈베리파이가 확인하는 주소: 지금 전광판에 띄울 버스 번호들
      m = path.match(/^\/stations\/([^/]+)\/pending$/);
      if (m && req.method === "GET") {
        if (req.headers.get("Authorization") !== `Bearer ${env.DEVICE_TOKEN}`)
          return send(env, { error: "권한 없음" }, 401);
        const { results } = await env.DB
          .prepare("SELECT DISTINCT bus_no FROM requests WHERE station_id = ? AND expires_at > ? ORDER BY created_at")
          .bind(decodeURIComponent(m[1]), now).all();
        return send(env, { buses: results.map((r) => r.bus_no) });
      }

      return send(env, { error: "없는 주소" }, 404);
    } catch (e) {
      return send(env, { error: "서버 오류" }, 500);
    }
  },
};
