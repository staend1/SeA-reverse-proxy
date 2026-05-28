# SeA Reverse Proxy

salesmap SDR 위젯 데모용 reverse proxy. 외부 사이트를 iframe으로 띄워 위젯을 임시 부착.

## 모드

| 모드 | 라우트 | 특징 |
|---|---|---|
| **default** | `/api/proxy?url=...` (query-string) | 5곳 중 4곳 커버하는 기본. base href는 cross-origin. |
| **compat** | `/api/proxy/c/{host}/...` (path-based) | default가 안 되는 사이트(HTTP-only, self-signed cert, Next.js Pages Router, mixed content 등) 대응. HTTP fallback / root-relative URL rewrite / setter patch / `history.replaceState` 정규화 등 들어가 있음. |

운영 흐름: **default 먼저 시도 → 안 되면 compat 권장**.

## 회귀 테스트 케이스 (Claude playwright 직접 검증)

배포 후 항상 아래 5개 URL을 playwright로 검증한다. **코드 테스트가 아니라 Claude가 직접 playwright MCP로 확인**.

### 테스트 URL (default 모드)
1. `https://sea-reverse-proxy.vercel.app/view?url=https%3A%2F%2Fsalesmap.kr&code=019cdd37-7313-7117-9f70-030d6fd1c3b1&env=prod&mode=default`
2. `https://sea-reverse-proxy.vercel.app/view?url=https%3A%2F%2Fsauce.im%2F&code=019dfc38-2594-7dd9-a499-de8a821d0fb1&env=prod&mode=default`
3. `https://sea-reverse-proxy.vercel.app/view?url=http%3A%2F%2Fwww.jireheng.co.kr%2F&code=019e6333-56e5-7ff1-9bad-7e5a57d18a71&env=prod&mode=default`
4. `https://sea-reverse-proxy.vercel.app/view?url=https%3A%2F%2Fwww.en-core.com&code=019df08c-dc43-7000-8629-935751e93dde&env=prod&mode=default`
5. `https://sea-reverse-proxy.vercel.app/view?url=http%3A%2F%2Fwww.jireheng.co.kr%2F&code=019e6333-56e5-7ff1-9bad-7e5a57d18a71&env=prod&mode=default`

### 각 URL 검증 절차 (Claude가 playwright로 수행)

**1. 최초 진입 검증 (default 모드)**
- `mcp__playwright__browser_navigate`로 URL 진입 → 4초 대기
- iframe 안 콘텐츠 평가:
  - `bodyHeight > 500` (페이지 콘텐츠 있음)
  - `imgs`의 `complete && naturalWidth > 0` 비율 **≥ 80%** (엑박 거의 없음)
  - `link[rel="stylesheet"]`가 모두 `.sheet`를 가짐 (CSS 로드 완료)
  - `h1` 또는 `h2`에 의미있는 텍스트
- 콘솔 에러 중 다음은 **NG**:
  - 자원 404
  - `ERR_CERT_AUTHORITY_INVALID`
  - `Mixed Content … blocked`
  - chunk JS 로드 실패
- 다음은 무시 (외부 노이즈):
  - `wcs is not defined` (Naver analytics)
  - favicon 404
  - 외부 광고/분석 트래커 차단

**2. AI 말풍선(nudge) 표시 검증**
- 진입 후 ~5초 더 대기
- outer view 페이지에 `iframe[src*="/nudge"]` 존재하면 OK
- `iframe[src*="/nudge"]`가 없으면 NG (nudge 400 등 prod 검증 실패)

**3. 내부 링크 클릭 → 이동 후 검증**
- iframe 안에서 의미있는 internal `<a>` 하나 선택 (textContent 비어있지 않고 raw href가 `#`이 아닌 것)
- `link.click()` → 4초 대기
- 이동 후 1번과 같은 기준으로 다시 검증
- 추가 NG 조건:
  - `iframe.contentWindow.location.href`가 우리 proxy app의 임의 path로 빠짐 (예: `https://sea-reverse-proxy.vercel.app/pricing` 같이 next.js 404가 뜬 경우)
  - `iframeTitle`이 "SeA Proxy Demo"로 바뀌어 있음 (우리 app의 404 페이지로 갔다는 신호)

### NG 결과 보고 양식
- 어느 URL에서 어느 단계(최초/nudge/내부이동)가 NG였는지
- 콘솔 에러 핵심 줄 1-3개
- `iframe.contentWindow.location.href`와 `iframeTitle`
- (이동 검증 NG일 때) 클릭한 링크의 raw href와 absolute href

### 컨텍스트
- default 모드가 안 되는 사이트는 compat 모드로 시도해보고, 그것도 안 되면 compat 보강 PR을 만든다.
- default 모드는 의도적으로 가볍게 유지 (대다수 사이트 빠르게 처리). compat을 까다로운 케이스용 강화 모드로 운영.
