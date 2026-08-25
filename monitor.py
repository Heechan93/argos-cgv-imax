# -*- coding: utf-8 -*-
"""
ARGOS CGV 영등포 IMAX 1분 감시 (GitHub Actions 상주형)

Cloudflare Cron Trigger가 계정 차원에서 dispatch되지 않는 장애가 있어
(scheduled 핸들러 자체는 정상, HTTP로 호출하면 동작) 감시를 여기로 되돌렸다.
GitHub 예약 실행은 최대 1시간까지 밀리므로 '예약을 자주 거는' 대신
한 번 뜬 잡이 LOOP_MINUTES 동안 1분 간격으로 상주하며 감시한다.
공개 저장소라 Actions 실행 시간은 무료·무제한이다.

감시 대상 : 영등포타임스퀘어 IMAX 「오디세이」 평일 18:00 이전 회차
알림 조건 : 아직 안 열린 날짜에 회차가 새로 등장 (= 신규 오픈)
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9))

SITE_NO = "0059"
SITE_NM = "영등포타임스퀘어"
MOVIE_KEYWORD = "오디세이"
SCREEN_KEYWORD = "IMAX"
CUTOFF_TIME = "1800"

LOOP_MINUTES = int(os.environ.get("LOOP_MINUTES", "70"))
PROBE_NARROW = 1   # 평소: 다음 평일 1일만
PROBE_WIDE = 4     # 10분마다: 4일치
PROBE_ONHIT = 6    # 오픈 감지 시: 6일치 전수
BLOCK_COOLDOWN_S = 600
BOOTSTRAP_DAYS = 20

BASE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(BASE, "state.json")
OPENINGS_LOG = os.path.join(BASE, "openings.log")

API = ("https://cgv.co.kr/api/v1/booking/searchMovScnInfo"
       "?coCd=A420&siteNo={site}&scnYmd={ymd}&rtctlScopCd=08")
BOOKING_URL = "https://cgv.co.kr/cnm/movieBook/cinema"

HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ko-KR,ko;q=0.9",
    "Referer": BOOKING_URL,
}

WEEKDAY_KO = ["월", "화", "수", "목", "금", "토", "일"]


class Blocked(Exception):
    """CGV 봇 차단 페이지(HTML)를 받았을 때."""


def fetch_show(date_ymd):
    """해당 날짜의 감시 대상 회차 목록. 차단이면 Blocked."""
    req = urllib.request.Request(API.format(site=SITE_NO, ymd=date_ymd), headers=HEADERS)
    with urllib.request.urlopen(req, timeout=20) as res:
        raw = res.read().decode("utf-8", "replace")
    if raw.lstrip().startswith("<"):
        raise Blocked()
    try:
        data = json.loads(raw)
    except ValueError:
        raise Blocked()
    rows = []
    for r in (data.get("data") or []):
        mov = (r.get("movNm") or "") + (r.get("expoProdNm") or "")
        scr = (r.get("scnsNm") or "") + (r.get("movkndDsplNm") or "")
        start = r.get("scnsrtTm") or ""
        if MOVIE_KEYWORD not in mov:
            continue
        if SCREEN_KEYWORD not in scr.upper():
            continue
        if not start or start >= CUTOFF_TIME:
            continue
        rows.append({
            "start": f"{start[:2]}:{start[2:]}",
            "free": int(r.get("frSeatCnt") or 0),
            "total": int(r.get("stcnt") or 0),
        })
    rows.sort(key=lambda x: x["start"])
    return rows


def next_weekdays(base_ymd, n):
    d = datetime.strptime(base_ymd, "%Y%m%d").date()
    out = []
    while len(out) < n:
        d += timedelta(days=1)
        if d.weekday() < 5:
            out.append(d.strftime("%Y%m%d"))
    return out


def fmt_date(y):
    d = datetime.strptime(y, "%Y%m%d").date()
    return f"{d.month}/{d.day}({WEEKDAY_KO[d.weekday()]})"


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            s = json.load(f)
            return s if isinstance(s, dict) else {}
    except Exception:
        return {}


def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2, sort_keys=True)


def send_telegram(text):
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        print("[테스트 모드] 텔레그램 미설정 — 전송 생략:\n" + text)
        return
    payload = urllib.parse.urlencode({
        "chat_id": chat_id, "text": text, "disable_web_page_preview": "true",
    }).encode("utf-8")
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage", data=payload,
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=20) as res:
        res.read()


def bootstrap():
    """지금 어디까지 열려 있는지 확인해 기준선을 잡는다(알림 없음)."""
    today = datetime.now(KST).date()
    horizon = today.strftime("%Y%m%d")
    for i in range(BOOTSTRAP_DAYS + 1):
        d = today + timedelta(days=i)
        if d.weekday() >= 5:
            continue
        y = d.strftime("%Y%m%d")
        try:
            if fetch_show(y) and y > horizon:
                horizon = y
        except Blocked:
            break
        except Exception:
            continue
        time.sleep(1)
    return horizon


def probe(horizon, count):
    """아직 안 열린 다음 평일들을 확인. (hits, new_horizon, blocked)"""
    hits, new_horizon = [], horizon
    for y in next_weekdays(horizon, count):
        try:
            rows = fetch_show(y)
        except Blocked:
            return hits, new_horizon, True
        except Exception:
            continue
        if rows:
            hits.append({"ymd": y, "rows": rows})
            if y > new_horizon:
                new_horizon = y
        time.sleep(1)
    return hits, new_horizon, False


def announce(hits, now):
    today = now.date()
    msg = (f"🚨 신규 회차 오픈 감지!\n{now.strftime('%Y-%m-%d %H:%M')} KST\n"
           f"━━━━━━━━━━━━━━━\n[{SITE_NM} IMAX]\n")
    for hit in hits:
        show = datetime.strptime(hit["ymd"], "%Y%m%d").date()
        msg += f"\n▸ {fmt_date(hit['ymd'])} (D-{(show - today).days})\n"
        msg += "\n".join(f"   {r['start']}  {r['free']}/{r['total']}석" for r in hit["rows"]) + "\n"
    msg += f"\n지금 바로 예매하세요 👇\n{BOOKING_URL}"
    send_telegram(msg)

    with open(OPENINGS_LOG, "a", encoding="utf-8") as f:
        for hit in hits:
            f.write("\t".join([
                now.strftime("%Y-%m-%d %H:%M"), hit["ymd"],
                hit["rows"][0]["start"], SITE_NM,
                f"{hit['rows'][0]['free']}/{hit['rows'][0]['total']}",
            ]) + "\n")


def main():
    state = load_state()
    horizon = state.get("horizon")
    if not horizon:
        horizon = bootstrap()
        save_state({"horizon": horizon})
        print(f"기준선 설정: {horizon}까지 예매 열림")

    print(f"영등포 IMAX 1분 감시 시작 (기준선 {horizon}, {LOOP_MINUTES}분간)")
    deadline = time.time() + LOOP_MINUTES * 60
    blocked_until = 0
    tick = 0

    while time.time() < deadline:
        tick += 1
        if time.time() >= blocked_until:
            wide = tick % 10 == 0
            hits, h2, blocked = probe(horizon, PROBE_WIDE if wide else PROBE_NARROW)
            if blocked:
                blocked_until = time.time() + BLOCK_COOLDOWN_S
                print(f"[{tick}] CGV 차단 감지 — 10분 대기", file=sys.stderr)
            elif hits:
                full_hits, full_h, _ = probe(horizon, PROBE_ONHIT)
                if len(full_hits) >= len(hits):
                    hits, h2 = full_hits, full_h
                now = datetime.now(KST)
                print(f"[{tick}] 신규 오픈 감지: {[h['ymd'] for h in hits]}")
                announce(hits, now)
                horizon = h2
                save_state({"horizon": horizon})
                return  # 잡을 끝내고 다음 잡이 새 기준선으로 이어받는다
            elif tick % 10 == 0:
                print(f"[{tick}] 감시 중 (기준선 {horizon})", flush=True)
        time.sleep(60)

    save_state({"horizon": horizon})
    print(f"{LOOP_MINUTES}분 감시 종료 (기준선 {horizon})")


if __name__ == "__main__":
    main()
