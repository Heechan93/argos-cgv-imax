# ARGOS · CGV IMAX 오디세이 좌석 알림봇

CGV **용산아이파크몰 / 영등포타임스퀘어 IMAX관**의 「오디세이」 상영 중
**평일(월~금) 18:00 이전 시작 회차**를 5분 간격으로 감시하고,
아래 두 가지 상황이 생기면 **텔레그램**으로 알림을 보낸다.

| 알림 | 의미 | 해야 할 일 |
|---|---|---|
| 🆕 신규 회차 오픈 | 새 평일 회차가 예매 목록에 등장 | 오픈 직후엔 명당(E~J열 중앙)이 비어 있으니 바로 예매 |

(취소표 알림은 사용자 요청으로 비활성화. 신규 오픈 이력은 `openings.log`에
쌓여서, CGV가 보통 무슨 요일 몇 시에 다음 회차를 여는지 패턴 분석에 쓰인다.)

> CGV 좌석 화면(어느 열이 비었는지)은 로그인이 필요해서 봇이 직접 볼 수 없다.
> 대신 위 두 시점을 잡으면 명당을 확보할 실질적 기회가 된다.

## 구조

**감시 본체 (현행)** — `cloudflare/worker.js`
- **1분 간격**으로 영등포타임스퀘어 IMAX만 감시 (Cloudflare Workers cron)
- 평소엔 1분에 CGV를 **1회**(아직 안 열린 다음 평일)만 조회하고, 10분마다 4일치를 훑는다.
  CGV는 짧은 시간에 요청이 몰리면 "비정상적으로 CGV에 접속" 차단 페이지를 돌려주기 때문.
- 차단 페이지를 받으면 10분간 쉬었다가 재개한다.
- 오픈 이력은 Workers KV(`STATE`)에 분 단위로 기록된다.
- 텔레그램 "현황" 응답도 이 Worker가 처리한다.

**과거 방식 (수동 실행용으로만 유지)** — `monitor.py` + `.github/workflows/monitor.yml`
- GitHub 예약 실행은 5분 크론을 걸어도 실제로는 최대 1시간까지 밀려서
  오픈 시각을 분 단위로 잡을 수 없었다. 그래서 예약 실행은 껐다.
- `state.json` / `openings.log` — 이 시절의 기록. 현황의 오픈 패턴에 계속 쓰인다.

## 설정 (GitHub Secrets)

저장소 Settings → Secrets and variables → Actions → New repository secret

| 이름 | 값 |
|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather가 알려준 봇 토큰 |
| `TELEGRAM_CHAT_ID` | 내 채팅 ID (SETUP.md 참고) |

시크릿이 없으면 봇은 알림 없이 로그만 남긴다(테스트 모드).

## 감시 조건 바꾸기

`monitor.py` 상단의 상수만 고치면 된다.

```python
MOVIE_KEYWORD = "오디세이"   # 감시할 영화
CUTOFF_TIME   = "1800"       # 이 시각 이전 시작 회차만
DAYS_AHEAD    = 14           # 며칠치 스케줄을 볼지
WEEKDAYS_ONLY = True         # 평일만
```
