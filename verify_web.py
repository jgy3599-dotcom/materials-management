"""
배포된 웹 화면이 실제로 제대로 뜨는지 브라우저를 자동으로 조종해서 확인합니다.

이 스크립트가 필요한 이유
  코드를 눈으로 보거나 문법만 검사해서는 못 잡는 것들이 있습니다. 실제로 며칠 전
  "표에 머리글만 나오고 행이 하나도 안 보이는" 문제가 있었는데, 문법 검사도 컬럼명
  대조도 전부 통과했었습니다. 화면을 진짜로 그려봐야만 알 수 있는 종류였습니다.

무엇을 보는가
  - 로그인이 되는지
  - 메뉴마다 화면이 바뀌는지
  - 표에 행이 실제로 그려지는지        <- 위에서 말한 그 문제
  - 브라우저 콘솔에 JS 오류가 뜨는지    <- 조용히 깨지는 것들이 여기 남습니다
  - BOQ 검색이 결과를 내는지

읽기만 합니다. 데이터를 바꾸거나 만들지 않습니다.
비밀번호는 화면에 안 보이게 입력받고 어디에도 저장하지 않습니다.

실행:  python verify_web.py
       python verify_web.py --show     (브라우저 창을 띄워서 눈으로 보며 확인)
"""
import getpass
import sys

from playwright.sync_api import sync_playwright

URL = "https://materials-management.pages.dev/"

results = []
console_errors = []


def check(name, passed, detail=""):
    results.append((name, bool(passed)))
    print(f"  [{'통과' if passed else '실패'}] {name}   {detail}")
    return bool(passed)


def count_rows(page, table_id):
    """표에 실제로 그려진 행 수를 셉니다."""
    return page.locator(f"#{table_id} .tabulator-row").count()


def main():
    show = "--show" in sys.argv

    print("=" * 78)
    print(f"웹 화면 검증 - {URL}")
    print("=" * 78)
    email = input("이메일: ").strip()
    password = getpass.getpass("비밀번호 (입력한 글자는 화면에 안 보입니다): ")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not show)
        page = browser.new_page(viewport={"width": 1400, "height": 900})

        # 브라우저 콘솔에 뜨는 오류를 모읍니다. 조용히 깨지는 것들이 여기 남습니다.
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))

        try:
            print("\n[1] 페이지 열기")
            page.goto(URL, wait_until="networkidle", timeout=30000)
            check("로그인 화면이 뜬다", page.locator("#login-view").is_visible())

            print("\n[2] 로그인")
            page.fill("#email", email)
            page.fill("#password", password)
            page.click("#login-btn")
            page.wait_for_selector("#app-view:not(.hidden)", timeout=20000)
            check("로그인 후 앱 화면으로 넘어간다", page.locator("#app-view").is_visible())
            check("이메일이 표시된다", email in page.locator("#user-email").inner_text())
            role = page.locator("#user-role").inner_text()
            check("권한이 표시된다", role in ("관리자", "일반"), f"권한={role}")

            print("\n[3] 요약 카드")
            page.wait_for_function(
                "document.getElementById('m-total').textContent !== '-'", timeout=15000)
            total = page.locator("#m-total").inner_text()
            check("전체 자재 건수가 채워진다", "건" in total and total != "-건", f"값={total}")

            print("\n[4] 자재 목록 - 표에 행이 그려지는지")
            page.click('.nav-btn[data-page="materials"]')
            page.wait_for_selector("#materials-table .tabulator-row", timeout=25000)
            n = count_rows(page, "materials-table")
            check("자재 목록 표에 행이 그려진다", n > 0, f"{n}행")
            check("페이지 넘김 줄이 있다", page.locator("#materials-table .tabulator-footer").count() > 0)

            print("\n[5] 사용(출고) 이력 - 표에 행이 그려지는지")
            page.click('.nav-btn[data-page="usage"]')
            page.wait_for_selector("#usage-table .tabulator-row", timeout=30000)
            n = count_rows(page, "usage-table")
            check("사용이력 표에 행이 그려진다", n > 0, f"{n}행")
            check("출고 등록 폼의 부품 선택칸이 채워진다",
                  page.locator("#usage-part option").count() > 0,
                  f"{page.locator('#usage-part option').count()}개")

            print("\n[6] 구매 요청")
            page.click('.nav-btn[data-page="purchase"]')
            page.wait_for_selector("#page-purchase:not(.hidden)", timeout=20000)
            page.wait_for_timeout(4000)
            check("구매 요청 화면이 보인다", page.locator("#page-purchase").is_visible())
            check("상태 필터가 채워진다", page.locator("#pr-status-filter option").count() > 1)

            print("\n[7] 수리 관리")
            page.click('.nav-btn[data-page="repairs"]')
            page.wait_for_selector("#repairs-table .tabulator-row", timeout=25000)
            n = count_rows(page, "repairs-table")
            check("수리 현황 표에 행이 그려진다", n > 0, f"{n}행")

            print("\n[8] BOQ 검색")
            page.click('.nav-btn[data-page="boq"]')
            page.fill("#boq-input", "LM101 BD001")
            page.click("#boq-search-btn")
            page.wait_for_selector("#boq-result:not(.hidden)", timeout=20000)
            spec = page.locator("#boq-spec").inner_text()
            check("검색 결과가 표시된다", len(spec.strip()) > 0, spec.strip().splitlines()[0][:40] if spec.strip() else "")

            print("\n[9] 브라우저 콘솔 오류")
            # 라이브러리가 내는 흔한 잡음은 걸러냅니다.
            real = [e for e in console_errors if "favicon" not in e.lower()]
            check("JS 오류가 없다", not real, f"{len(real)}건" if real else "")
            for e in real[:5]:
                print(f"        - {e[:110]}")

        finally:
            browser.close()

    print("\n" + "=" * 78)
    failed = [n for n, ok in results if not ok]
    for name, ok in results:
        print(f"  [{'통과' if ok else '실패'}] {name}")
    print("=" * 78)
    if failed:
        print(f"{len(failed)}개 실패: {', '.join(failed)}")
        print("--show 를 붙여 실행하면 브라우저 창이 떠서 눈으로 확인할 수 있습니다.")
    else:
        print(f"전체 통과 ({len(results)}개 항목) - 웹 화면이 정상 동작합니다.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
