# 텔레그램 봇 만들기 (5분, 휴대폰만 있으면 됨)

## 1. 텔레그램 설치 & 봇 생성

1. 휴대폰에 **텔레그램(Telegram)** 앱 설치 후 가입한다.
2. 텔레그램 검색창에 `BotFather` 를 검색해 대화를 연다.
   (파란 체크 표시가 있는 공식 계정인지 확인)
3. `/newbot` 을 입력한다.
4. 봇 이름을 물어보면 예: `ARGOS CGV 알림` 입력.
5. 봇 아이디를 물어보면 `bot`으로 끝나는 아이디 입력. 예: `argos_cgv_bot`
   (이미 있는 아이디면 다른 이름으로)
6. 성공하면 BotFather가 **토큰**을 알려준다.
   `1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` 모양의 긴 문자열.
   → 이것이 `TELEGRAM_BOT_TOKEN`

## 2. 내 채팅 ID 알아내기

1. 텔레그램 검색창에서 방금 만든 봇(예: `argos_cgv_bot`)을 찾아 대화를 열고
   **시작(START)** 버튼을 누른 뒤, 아무 메시지나 하나 보낸다. (예: "안녕")
2. PC 브라우저에서 아래 주소를 연다 (`<토큰>` 자리에 1번의 토큰을 붙여넣기):
   ```
   https://api.telegram.org/bot<토큰>/getUpdates
   ```
3. 화면에 나온 글자 중 `"chat":{"id":123456789` 부분의 숫자가
   → `TELEGRAM_CHAT_ID`

## 3. GitHub에 등록

1. https://github.com/Heechan93/argos-cgv-imax/settings/secrets/actions 접속
2. **New repository secret** 클릭
3. Name: `TELEGRAM_BOT_TOKEN`, Secret: 토큰 붙여넣기 → Add secret
4. 한 번 더 New repository secret 클릭
5. Name: `TELEGRAM_CHAT_ID`, Secret: 채팅 ID 숫자 붙여넣기 → Add secret

끝. 다음 실행부터 알림이 온다.
