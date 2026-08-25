/**
 * ARGOS CGV 영등포 IMAX 1분 감시 + 현황 응답 (Cloudflare Worker)
 *
 * [scheduled] 1분마다 영등포타임스퀘어 IMAX 「오디세이」의 '아직 안 열린 다음 평일'을
 *             확인해, 새 회차가 열리는 순간(분 단위)을 잡아 텔레그램으로 알린다.
 * [fetch]     텔레그램에서 "현황"을 보내면 잔여석 표 + 오픈 패턴을 답장한다.
 *
 * 시크릿: BOT_TOKEN, ALLOWED_CHAT_ID, WEBHOOK_SECRET
 * KV 바인딩: STATE
 *
 * CGV 봇 차단(“비정상적으로 CGV에 접속”)을 피하려고 평소엔 1분에 1회만 호출하고,
 * 10분마다 한 번씩만 넓게(4일) 훑는다. 차단이 감지되면 10분간 쉰다.
 */

const SITE_NO = "0059";
const SITE_NM = "영등포타임스퀘어";
const ALL_SITES = { "0013": "용산아이파크몰", "0059": "영등포타임스퀘어" };

const MOVIE_KEYWORD = "오디세이";
const SCREEN_KEYWORD = "IMAX";
const CUTOFF_TIME = "1800";
const DAYS_AHEAD = 20;
const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

const PROBE_NARROW = 1; // 평소: 다음 평일 1일만 확인
const PROBE_WIDE = 4; // 10분마다: 4일치 확인 (건너뛴 날 대비)
const PROBE_ONHIT = 6; // 오픈 감지 시: 6일치 전수 조사
const BLOCK_COOLDOWN_MS = 10 * 60 * 1000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "ko-KR,ko;q=0.9",
  Referer: "https://cgv.co.kr/cnm/movieBook/cinema",
};

const OPENINGS_LOG_URL =
  "https://raw.githubusercontent.com/Heechan93/argos-cgv-imax/main/openings.log";

/* ───────────────────────── 공통 유틸 ───────────────────────── */

/** KST 기준 시각. 값은 반드시 getUTC*() 로 읽는다. */
function kstNow() {
  return new Date(Date.now() + 9 * 3600 * 1000);
}

function ymd(d) {
  return (
    d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, "0") +
    String(d.getUTCDate()).padStart(2, "0")
  );
}

function dayFromYmd(y) {
  return new Date(`${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}T00:00:00Z`);
}

function labelOf(d) {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAY_KO[d.getUTCDay()]})`;
}

function labelYmd(y) {
  return labelOf(dayFromYmd(y));
}

function stampOf(d) {
  return (
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getUTCDate()).padStart(2, "0")} ` +
    `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`
  );
}

function isWeekend(d) {
  const w = d.getUTCDay();
  return w === 0 || w === 6;
}

/** base 다음 평일들을 n개 만든다. */
function nextWeekdays(baseYmd, n) {
  const out = [];
  const d = dayFromYmd(baseYmd);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (!isWeekend(d)) out.push(ymd(d));
  }
  return out;
}

class BlockedError extends Error {}

/** 특정 극장/날짜의 감시 대상(IMAX 오디세이 평일 18시 전) 회차 목록. */
async function fetchShow(siteNo, dateYmd) {
  const url =
    `https://cgv.co.kr/api/v1/booking/searchMovScnInfo` +
    `?coCd=A420&siteNo=${siteNo}&scnYmd=${dateYmd}&rtctlScopCd=08`;
  const res = await fetch(url, { headers: HEADERS });
  const text = await res.text();
  // 차단 페이지는 JSON이 아니라 HTML로 온다.
  if (!res.ok || text.trimStart().startsWith("<")) throw new BlockedError("blocked");
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new BlockedError("unparsable");
  }
  return (j.data || [])
    .filter((r) => {
      const mov = (r.movNm || "") + (r.expoProdNm || "");
      const scr = (r.scnsNm || "") + (r.movkndDsplNm || "");
      const start = r.scnsrtTm || "";
      return (
        mov.includes(MOVIE_KEYWORD) &&
        scr.toUpperCase().includes(SCREEN_KEYWORD) &&
        start &&
        start < CUTOFF_TIME
      );
    })
    .map((r) => ({
      start: `${r.scnsrtTm.slice(0, 2)}:${r.scnsrtTm.slice(2)}`,
      free: parseInt(r.frSeatCnt || "0", 10),
      total: parseInt(r.stcnt || "0", 10),
    }))
    .sort((a, b) => a.start.localeCompare(b.start));
}

async function send(env, text) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.ALLOWED_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
}

/* ───────────────────────── 1분 감시 ───────────────────────── */

/**
 * 아직 안 열린 다음 평일들을 확인해 새로 열린 날을 찾는다.
 * @returns {{hits: Array, horizon: string|null, blocked: boolean}}
 */
async function probe(horizon, count) {
  const candidates = nextWeekdays(horizon, count);
  const hits = [];
  let newHorizon = horizon;
  for (const d of candidates) {
    let rows;
    try {
      rows = await fetchShow(SITE_NO, d);
    } catch (e) {
      if (e instanceof BlockedError) return { hits, horizon: newHorizon, blocked: true };
      continue; // 일시적 네트워크 오류는 다음 분에 다시 본다
    }
    if (rows.length) {
      hits.push({ ymd: d, rows });
      if (d > newHorizon) newHorizon = d;
    }
  }
  return { hits, horizon: newHorizon, blocked: false };
}

/** 첫 실행: 지금 어디까지 열려 있는지 확인해 기준선을 잡는다(알림 없음). */
async function bootstrap(env) {
  const now = kstNow();
  let horizon = ymd(now);
  for (let i = 0; i <= DAYS_AHEAD; i++) {
    const d = new Date(now.getTime() + i * 86400 * 1000);
    if (isWeekend(d)) continue;
    try {
      const rows = await fetchShow(SITE_NO, ymd(d));
      if (rows.length && ymd(d) > horizon) horizon = ymd(d);
    } catch (e) {
      if (e instanceof BlockedError) break;
    }
  }
  await env.STATE.put("horizon", horizon);
  return horizon;
}

async function runWatch(env) {
  const now = kstNow();

  const blockedUntil = parseInt((await env.STATE.get("blockedUntil")) || "0", 10);
  if (Date.now() < blockedUntil) return { skipped: "cooldown" };

  let horizon = await env.STATE.get("horizon");
  if (!horizon) {
    horizon = await bootstrap(env);
    return { bootstrapped: horizon };
  }

  const wide = now.getUTCMinutes() % 10 === 0;
  let { hits, horizon: h2, blocked } = await probe(horizon, wide ? PROBE_WIDE : PROBE_NARROW);

  if (blocked) {
    await env.STATE.put("blockedUntil", String(Date.now() + BLOCK_COOLDOWN_MS));
    return { blocked: true };
  }
  if (!hits.length) return { checked: wide ? PROBE_WIDE : PROBE_NARROW, horizon };

  // 오픈 감지 → 같이 열린 날이 더 있는지 넓게 확인
  const full = await probe(horizon, PROBE_ONHIT);
  if (full.hits.length >= hits.length) {
    hits = full.hits;
    h2 = full.horizon;
  }

  const stamp = stampOf(now);
  let msg =
    `🚨 신규 회차 오픈 감지!\n${stamp} KST\n` +
    `━━━━━━━━━━━━━━━\n[${SITE_NM} IMAX]\n`;
  for (const hit of hits) {
    const dday = Math.round((dayFromYmd(hit.ymd) - dayFromYmd(ymd(now))) / 86400000);
    msg += `\n▸ ${labelYmd(hit.ymd)} (D-${dday})\n`;
    msg += hit.rows.map((r) => `   ${r.start}  ${r.free}/${r.total}석`).join("\n") + "\n";
  }
  msg += `\n지금 바로 예매하세요 👇\nhttps://cgv.co.kr/cnm/movieBook/cinema`;
  await send(env, msg);

  // 오픈 이력 기록 (패턴 분석용)
  const log = JSON.parse((await env.STATE.get("openings")) || "[]");
  for (const hit of hits) {
    log.push({
      detectedAt: stamp,
      showYmd: hit.ymd,
      count: hit.rows.length,
      free: hit.rows.map((r) => r.free).join(","),
    });
  }
  await env.STATE.put("openings", JSON.stringify(log.slice(-200)));
  await env.STATE.put("horizon", h2);
  return { alerted: hits.map((h) => h.ymd), horizon: h2 };
}

/* ───────────────────────── 현황 응답 ───────────────────────── */

async function buildReport(env) {
  const now = kstNow();
  const jobs = [];
  for (const siteNo of Object.keys(ALL_SITES)) {
    for (let i = 0; i <= DAYS_AHEAD; i++) {
      const d = new Date(now.getTime() + i * 86400 * 1000);
      if (isWeekend(d)) continue;
      jobs.push(
        fetchShow(siteNo, ymd(d))
          .then((rows) => ({ siteNo, date: d, rows }))
          .catch(() => ({ siteNo, date: d, rows: [] }))
      );
    }
  }
  const results = await Promise.all(jobs);

  const bySite = {};
  let maxOpen = null;
  for (const { siteNo, date, rows } of results) {
    if (!rows.length) continue;
    if (!maxOpen || date > maxOpen) maxOpen = date;
    const parts = rows.map((r) => `${r.start} ${r.free === 0 ? "매진" : r.free + "석"}`);
    (bySite[siteNo] = bySite[siteNo] || []).push(`${labelOf(date)} ${parts.join(" · ")}`);
  }

  let out = `📊 IMAX 오디세이 현황 (평일 18시 전)\n기준: ${stampOf(now)} KST\n`;
  for (const siteNo of Object.keys(ALL_SITES)) {
    out += `\n[${ALL_SITES[siteNo]}]\n`;
    out +=
      bySite[siteNo] && bySite[siteNo].length
        ? bySite[siteNo].join("\n") + "\n"
        : "예매 가능한 회차 없음\n";
  }

  out += "\n📅 오픈 예측\n";
  if (maxOpen) {
    const next = new Date(maxOpen.getTime());
    do next.setUTCDate(next.getUTCDate() + 1);
    while (isWeekend(next));
    out += `현재 ${labelOf(maxOpen)}까지 열림 → 다음 오픈 대상: ${labelOf(next)}~\n`;
  }
  const events = await openingHistory(env);
  if (events.length) {
    out += "관측된 오픈 시각:\n";
    for (const e of events.slice(-4)) out += `· ${e}\n`;
  }
  out += `\n⏱ 영등포는 1분 간격으로 감시 중입니다.`;
  return out;
}

/** KV(정밀) + GitHub 로그(과거)를 합쳐 오픈 이력 문장 목록을 만든다. */
async function openingHistory(env) {
  const byDay = {};
  const add = (detectedAt, showYmd) => {
    const [day, time] = detectedAt.split(" ");
    const e = (byDay[day] = byDay[day] || { times: [], shows: [] });
    e.times.push(time);
    e.shows.push(showYmd);
  };

  try {
    for (const r of JSON.parse((await env.STATE.get("openings")) || "[]")) {
      add(r.detectedAt, r.showYmd);
    }
  } catch (e) {
    /* 무시 */
  }
  try {
    const res = await fetch(OPENINGS_LOG_URL);
    if (res.ok) {
      for (const ln of (await res.text()).trim().split("\n")) {
        const [ts, showYmd] = ln.split("\t");
        if (ts && showYmd) add(ts, showYmd);
      }
    }
  } catch (e) {
    /* 무시 */
  }

  return Object.keys(byDay)
    .sort()
    .map((day) => {
      const e = byDay[day];
      e.times.sort();
      e.shows.sort();
      const t0 = e.times[0];
      const t1 = e.times[e.times.length - 1];
      const s0 = e.shows[0];
      const s1 = e.shows[e.shows.length - 1];
      const tRange = t0 === t1 ? t0 : `${t0}~${t1}`;
      const sRange = s0 === s1 ? labelYmd(s0) : `${labelYmd(s0)}~${labelYmd(s1)}`;
      return `${labelOf(new Date(day + "T00:00:00Z"))} ${tRange} → ${sRange} 회차`;
    });
}

function splitMessage(text, limit = 3800) {
  const parts = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if ((buf + "\n" + line).length > limit) {
      parts.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + "\n" + line : line;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

/* ───────────────────────── 엔트리포인트 ───────────────────────── */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runWatch(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // 배포 점검용: 감시 로직을 즉시 1회 실행하고 결과를 JSON으로 돌려준다.
    if (url.pathname === "/debug" && url.searchParams.get("key") === env.WEBHOOK_SECRET) {
      const action = url.searchParams.get("action");
      if (action === "reset") await env.STATE.delete("horizon");
      if (action === "state") {
        return Response.json({
          horizon: await env.STATE.get("horizon"),
          blockedUntil: await env.STATE.get("blockedUntil"),
          openings: JSON.parse((await env.STATE.get("openings")) || "[]"),
        });
      }
      return Response.json(await runWatch(env));
    }

    if (request.method !== "POST") return new Response("ARGOS CGV watcher");
    if (
      env.WEBHOOK_SECRET &&
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET
    ) {
      return new Response("forbidden", { status: 403 });
    }

    const update = await request.json().catch(() => null);
    const msg = update && update.message;
    const chatId = msg && msg.chat && msg.chat.id;
    const text = ((msg && msg.text) || "").trim();
    if (!chatId || String(chatId) !== String(env.ALLOWED_CHAT_ID)) return new Response("ok");

    if (text.includes("현황")) {
      for (const part of splitMessage(await buildReport(env))) await send(env, part);
    } else if (text && !text.startsWith("/")) {
      await send(env, "「현황」이라고 보내면 IMAX 오디세이 잔여석 표를 보내드려요 🎬");
    }
    return new Response("ok");
  },
};
