"""
구매 요청 흐름이 실제 DB에서 제대로 도는지 확인하는 스크립트입니다.
웹 화면(web/js/pages/purchase.js)이 하는 것과 똑같은 순서로 DB를 건드려서 결과를 확인합니다.

안전장치
  - 테스트 전용 자재를 새로 하나 만들어서 그것으로만 시험합니다. 실제 자재는 건드리지 않습니다.
  - 끝나면 만든 것을 전부 지웁니다. 중간에 실패해도 지우려고 시도합니다.
  - 비밀번호는 화면에 안 보이게 입력받고 어디에도 저장하지 않습니다.

준비물
  - 관리자 계정. 요청 상태 변경과 뒷정리에 관리자 권한이 필요합니다.

실행:  python verify_purchase.py
"""
import getpass
import sys
import tomllib
from datetime import date, datetime, timezone
from pathlib import Path

from supabase import create_client

TEST_PART_NAME = "__검증용_구매요청_임시자재__(자동삭제됨)"
START_QTY = 10
REQUEST_QTY = 5
APPROVED_QTY = 7      # 검토 중에 수량을 고치는 상황을 재현합니다

results = []
created = {"material_id": None, "request_ids": []}


def now():
    return datetime.now(timezone.utc).isoformat()


def check(name, expected, actual):
    passed = expected == actual
    results.append((name, passed))
    print(f"  [{'통과' if passed else '실패'}] {name}   (기대 {expected!r} / 실제 {actual!r})")
    return passed


def check_true(name, condition, detail=""):
    results.append((name, bool(condition)))
    print(f"  [{'통과' if condition else '실패'}] {name}   {detail}")
    return bool(condition)


def main():
    secrets_path = Path(__file__).parent / ".streamlit" / "secrets.toml"
    if not secrets_path.exists():
        sys.exit(f"secrets.toml을 찾을 수 없습니다: {secrets_path}")
    with open(secrets_path, "rb") as f:
        secrets = tomllib.load(f)

    client = create_client(secrets["supabase"]["url"], secrets["supabase"]["key"])

    print("=" * 78)
    print("구매 요청 흐름 검증 - 관리자 계정으로 로그인해주세요")
    print("=" * 78)
    email = input("이메일: ").strip()
    password = getpass.getpass("비밀번호 (입력한 글자는 화면에 안 보입니다): ")
    try:
        auth = client.auth.sign_in_with_password({"email": email, "password": password})
    except Exception as e:
        sys.exit(f"\n로그인에 실패했습니다: {e}")

    role = (auth.user.user_metadata or {}).get("role", "일반")
    client.postgrest.auth(auth.session.access_token)
    print(f"\n로그인 성공: {auth.user.email} (권한: {role})")
    if role != "관리자":
        sys.exit("관리자 계정이 필요합니다. 요청 상태 변경과 뒷정리를 할 수 없습니다.")

    def qty():
        r = client.table("materials").select("current_qty").eq("id", created["material_id"]).execute()
        return r.data[0]["current_qty"]

    def request_row(request_id):
        r = client.table("purchase_requests").select("*").eq("id", request_id).execute()
        return r.data[0] if r.data else None

    def open_count():
        """웹의 countOpenRequests와 같은 조건 - 아직 끝나지 않은 요청 수"""
        r = client.table("purchase_requests").select("id", count="exact").eq(
            "material_id", created["material_id"]
        ).in_("status", ["요청됨", "검토중", "승인됨", "구매중"]).execute()
        return r.count or 0

    try:
        # ---------- 준비 ----------
        print("\n[준비] 테스트 전용 자재를 만듭니다")
        made = client.table("materials").insert({
            "category": "__검증용__", "part_name": TEST_PART_NAME,
            "standard_qty": START_QTY, "current_qty": START_QTY,
            "note": "verify_purchase.py가 만든 임시 자재입니다. 남아있으면 지워도 됩니다.",
        }).execute()
        created["material_id"] = made.data[0]["id"]
        mid = created["material_id"]
        print(f"       자재 id={mid}, 현재재고 {START_QTY}개로 시작")

        # ---------- 1. 요청 등록 ----------
        print(f"\n[1] 구매요청 등록 ({REQUEST_QTY}개)")
        req = client.table("purchase_requests").insert({
            "material_id": mid, "requested_qty": REQUEST_QTY,
            "requester_email": auth.user.email, "request_note": "검증용", "status": "요청됨",
        }).execute()
        rid = req.data[0]["id"]
        created["request_ids"].append(rid)
        check("상태가 '요청됨'이다", "요청됨", request_row(rid)["status"])
        check("진행 중 요청으로 잡힌다", 1, open_count())

        # ---------- 2. 검토 시작 ----------
        print("\n[2] 검토 시작")
        client.table("purchase_requests").update(
            {"status": "검토중", "reviewed_at": now()}).eq("id", rid).execute()
        row = request_row(rid)
        check("상태가 '검토중'이다", "검토중", row["status"])
        check_true("검토 시각이 기록됐다", row["reviewed_at"] is not None)

        # ---------- 3. 승인 (수량 변경) ----------
        print(f"\n[3] 승인 - 검토 중에 수량을 {REQUEST_QTY} -> {APPROVED_QTY}로 고침")
        client.table("purchase_requests").update(
            {"status": "승인됨", "approved_at": now(), "requested_qty": APPROVED_QTY}
        ).eq("id", rid).execute()
        row = request_row(rid)
        check("상태가 '승인됨'이다", "승인됨", row["status"])
        check("요청수량이 고쳐졌다", APPROVED_QTY, row["requested_qty"])

        # ---------- 4. 구매 처리 ----------
        print("\n[4] 구매 처리 (거래업체·단가 입력)")
        client.table("purchase_requests").update(
            {"status": "구매중", "purchased_at": now(), "vendor": "검증용업체", "unit_price": 1500}
        ).eq("id", rid).execute()
        row = request_row(rid)
        check("상태가 '구매중'이다", "구매중", row["status"])
        check("거래업체가 저장됐다", "검증용업체", row["vendor"])

        # ---------- 5. 입고 처리 ----------
        print(f"\n[5] 입고 처리 {APPROVED_QTY}개 (재고 증가 + 구매이력 + 상태변경이 한 묶음)")
        client.rpc("receive_purchase_request", {
            "p_request_id": rid, "p_material_id": mid, "p_received_qty": APPROVED_QTY,
            "p_vendor": "검증용업체", "p_unit_price": 1500, "p_received_on": date.today().isoformat(),
        }).execute()
        row = request_row(rid)
        check("상태가 '입고완료'다", "입고완료", row["status"])
        check("입고수량이 기록됐다", APPROVED_QTY, row["received_qty"])
        check("재고가 늘었다", START_QTY + APPROVED_QTY, qty())
        hist = client.table("purchase_history").select("*").eq("material_id", mid).execute().data
        check("구매이력이 1줄 생겼다", 1, len(hist))
        check("진행 중 요청에서 빠졌다", 0, open_count())

        # ---------- 6. 삭제 (재고 원복) ----------
        print("\n[6] 입고완료된 요청 삭제 (재고 원복 + 구매이력은 취소표시만)")
        client.rpc("remove_purchase_request", {"p_request_id": rid}).execute()
        check("재고가 원복됐다", START_QTY, qty())
        hist = client.table("purchase_history").select("*").eq("material_id", mid).execute().data
        check("구매이력은 안 지워졌다", 1, len(hist))
        check_true("구매이력에 취소일시가 채워졌다", hist[0]["reverted_at"] is not None,
                   f"reverted_at={hist[0]['reverted_at']}")
        check("구매요청은 삭제됐다", None, request_row(rid))
        created["request_ids"].remove(rid)

        # ---------- 7. 반려 ----------
        print("\n[7] 새 요청을 만들어 반려 처리")
        req2 = client.table("purchase_requests").insert({
            "material_id": mid, "requested_qty": 3,
            "requester_email": auth.user.email, "status": "검토중",
        }).execute()
        rid2 = req2.data[0]["id"]
        created["request_ids"].append(rid2)
        client.table("purchase_requests").update(
            {"status": "반려됨", "rejected_at": now(), "reject_reason": "검증용 반려"}
        ).eq("id", rid2).execute()
        row = request_row(rid2)
        check("상태가 '반려됨'이다", "반려됨", row["status"])
        check("반려 사유가 저장됐다", "검증용 반려", row["reject_reason"])
        check("반려된 건은 진행 중으로 안 잡힌다", 0, open_count())
        check("반려는 재고를 건드리지 않는다", START_QTY, qty())

    finally:
        # ---------- 뒷정리 ----------
        print("\n[뒷정리] 테스트로 만든 데이터를 지웁니다")
        mid = created["material_id"]
        if mid:
            try:
                client.table("purchase_history").delete().eq("material_id", mid).execute()
                client.table("purchase_requests").delete().eq("material_id", mid).execute()
                client.table("materials").delete().eq("id", mid).execute()
                left = client.table("materials").select("id").eq("id", mid).execute().data
                print("       전부 정리됐습니다" if not left
                      else f"       자재 id={mid}가 남아있습니다. 직접 지워주세요")
            except Exception as e:
                print(f"       정리 중 오류: {e}")
                print(f"       자재 id={mid} ('{TEST_PART_NAME}')를 직접 지워주세요")

    print("\n" + "=" * 78)
    failed = [n for n, ok in results if not ok]
    for name, ok in results:
        print(f"  [{'통과' if ok else '실패'}] {name}")
    print("=" * 78)
    if failed:
        print(f"{len(failed)}개 실패: {', '.join(failed)}")
        print("이 내용을 그대로 알려주시면 원인을 찾겠습니다.")
    else:
        print(f"전체 통과 ({len(results)}개 항목) - 구매 요청 흐름이 정상 동작합니다.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
