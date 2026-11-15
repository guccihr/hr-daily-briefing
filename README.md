# hr-daily-briefing

HR 대시보드의 Daily Briefing을 매일 자동으로 만드는 저장소. 비용 없음.

- **일정** : GitHub Actions가 매일 06:00 KST에 `generate.mjs`를 실행 (`.github/workflows/daily-briefing.yml`)
- **LLM** : GitHub Models 무료 한도 (`GITHUB_TOKEN`, 별도 API 키 없음). 모델은 `BRIEFING_MODEL` 환경 변수로 변경
- **뉴스** : 공개 RSS 피드(HR Dive, Retail Dive, Google News 검색)에서 후보를 모으고 LLM이 3건을 골라 한국어·영어로 요약. 제목·출처·링크는 피드 원본 그대로 쓴다
- **분석** : `topics.json`의 실제 출처 목록을 날짜순으로 돌려 쓰고 LLM이 설명을 쓴다
- **노동법** : `laws.json`에 미리 써 둔 조문 요약을 날짜순으로 돌려 쓴다 (LLM이 법 내용을 쓰지 않는다)
- **결과** : `briefings/YYYY-MM-DD.json`, `briefings/index.json` — 대시보드가 이 파일을 읽는다

이 저장소는 **공개(public)** 여야 한다. 대시보드가 `raw.githubusercontent.com`에서 로그인 없이 읽고, 공개 저장소는 Actions가 무료다.
대시보드 데이터·사내 정보는 여기에 넣지 않는다.

```bash
node generate.mjs --dry          # LLM 없이 피드 수집·형식 점검
GITHUB_TOKEN=... node generate.mjs 2026-11-16
```
