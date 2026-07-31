"""
3단계 수정(재고 변경과 기록 남기기를 SQL 함수로 묶은 것 + 초과 반납 검증)이
실제 DB에서 제대로 도는지 자동으로 확인하는 스크립트입니다.

안전장치
  - 테스트 전용 자재를 새로 하나 만들어서 그것으로만 시험합니다. 실제 자재는 건드리지 않습니다.
  - 끝나면 만든 것을 전부 지웁니다. 중간에 실패해도 지우려고 시도합니다.
  - 비밀번호는 화면에 안 보이게 입력받고, 어디에도 저장하지 않습니다.

준비물
  - 관리자 계정. 구매요청 처리와 뒷정리에 관리자 권한이 필요합니다.
  - .streamlit/secrets.toml (앱이 쓰는 것과 같은 파일을 그대로 읽습니다)

실행:  python verify_stage3.py
"""
import getpass
import sys
import tomllib
from datetime import date
from pathlib import Path

from supabase import create_client

TODAY = date.today().isoformat()
TEST_PART_NAME = "__검증용_임시자재__(자동삭제됨)"
START_QTY = 10

results = []
created = {"material_id": None, "request_id": None}


def check(name, expected, actual):
    passed = expected == actual
    results.append((name, passed, f"기대 {expected} / 실제 {actual}"))
    mark = "통과" if passed else "실패"
    print(f"  [{mark}] {name}   (기대 {expected} / 실제 {actual})")
    return passed


def check_true(name, condition, detail=""):
    results.append((name, bool(condition), detail))
    print(f"  [{'통과' if condition else '실패'}] {name}   {detail}")
    return bool(condition)


def main():
    secrets_path = Path(__file__).parent / ".streamlit" / "secrets.toml"
    if not secrets_path.exists():
        sys.exit(f"secrets.toml을 찾을 수 없습니다: {secrets_path}")
    with open(secrets_path, "rb") as f:
        secrets = tomllib.load(f)

    client = create_client(secrets["supabase"]["url"], secrets["supabase"]["key"])

    print("=" * 74)
    print("3단계 검증 - 관리자 계정으로 로그인해주세요")
    print("=" * 74)
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
        sys.exit("관리자 계정이 필요합니다. 구매요청 처리와 뒷정리를 할 수 없습니다.")

    def qty():
        """테스트 자재의 현재재고를 DB에서 다시 읽어옵니다."""
        r = client.table("materials").select("current_qty").eq("id", created["material_id"]).execute()
        return r.data[0]["current_qty"]

    def count(table, column, value):
        r = client.table(table).select("id", count="exact").eq(column, value).execute()
        return r.count or 0

    try:
        # ---------- 준비 ----------
        print("\n[준비] 테스트 전용 자재를 만듭니다")
        made = client.table("materials").insert({
            "category": "__검증용__", "part_name": TEST_PART_NAME,
            "standard_qty": START_QTY, "current_qty": START_QTY,
            "note": "verify_stage3.py가 만든 임시 자재입니다. 남아있으면 지워도 됩니다.",
        }).execute()
        created["material_id"] = made.data[0]["id"]
        mid = created["material_id"]
        print(f"       자재 id={mid}, 현재재고 {START_QTY}개로 시작")

        # ---------- 1 ----------
        print("\n[1] 출고 등록 - 출처 '한진 SPARE' 3개 (재고가 깎여야 함)")
        client.rpc("register_usage", {
            "p_occurred_on": TODAY, "p_material_id": mid, "p_quantity": 3,
            "p_manager": "한진 SPARE", "p_note": "검증용", "p_equipment_id": None,
            "p_problem": "검증용 고장", "p_action_taken": None, "p_part_memo": None,
            "p_deduct_stock": True,
        }).execute()
        check("재고가 3개 줄었다", START_QTY - 3, qty())
        check("수리 건이 자동 생성됐다", 1, count("repairs", "material_id", mid))
        check("출고 이력이 남았다", 1, count("history", "material_id", mid))

        # ---------- 2 ----------
        print("\n[2] 출고 등록 - 출처 '보우' 2개 (이력만 남고 재고는 그대로여야 함)")
        client.rpc("register_usage", {
            "p_occurred_on": TODAY, "p_material_id": mid, "p_quantity": 2,
            "p_manager": "보우", "p_note": "검증용", "p_equipment_id": None,
            "p_problem": None, "p_action_taken": None, "p_part_memo": None,
            "p_deduct_stock": False,
        }).execute()
        check("재고가 그대로다", START_QTY - 3, qty())
        check("수리 건은 안 늘었다", 1, count("repairs", "material_id", mid))
        check("출고 이력은 늘었다", 2, count("history", "material_id", mid))

        # ---------- 3 ----------
        print("\n[3] 구매요청 -> 입고 처리 5개 (재고가 늘고 구매이력이 남아야 함)")
        req = client.table("purchase_requests").insert({
            "material_id": mid, "requested_qty": 5, "status": "구매중",
            "requester_email": auth.user.email, "vendor": "검증용업체", "unit_price": 1000,
        }).execute()
        created["request_id"] = req.data[0]["id"]
        rid = created["request_id"]

        client.rpc("receive_purchase_request", {
            "p_request_id": rid, "p_material_id": mid, "p_received_qty": 5,
            "p_vendor": "검증용업체", "p_unit_price": 1000, "p_received_on": TODAY,
        }).execute()
        check("재고가 5개 늘었다", START_QTY - 3 + 5, qty())
        check("구매이력이 1줄 생겼다", 1, count("purchase_history", "material_id", mid))
        status = client.table("purchase_requests").select("status").eq("id", rid).execute().data[0]["status"]
        check("요청 상태가 바뀌었다", "입고완료", status)

        # ---------- 4 ----------
        print("\n[4] 그 구매요청 삭제 (재고는 원복, 구매이력은 남되 취소표시)")
        client.rpc("remove_purchase_request", {"p_request_id": rid}).execute()
        check("재고가 원복됐다", START_QTY - 3, qty())
        check("구매이력은 안 지워졌다", 1, count("purchase_history", "material_id", mid))
        ph = client.table("purchase_history").select("reverted_at").eq("material_id", mid).execute().data[0]
        check_true("구매이력에 취소일시가 채워졌다", ph["reverted_at"] is not None, f"reverted_at={ph['reverted_at']}")
        check("구매요청은 삭제됐다", 0, count("purchase_requests", "id", rid))
        created["request_id"] = None

        # ---------- 5 ----------
        repair_id = client.table("repairs").select("id").eq("material_id", mid).execute().data[0]["id"]
        print(f"\n[5] 수리 반납 - '정상복귀' 1개 (재고가 늘어야 함)  수리건 id={repair_id}")
        client.rpc("add_repair_return", {
            "p_repair_id": repair_id, "p_returned_qty": 1, "p_returned_on": TODAY,
            "p_outcome": "정상복귀", "p_note": "검증용",
        }).execute()
        check("재고가 1개 늘었다", START_QTY - 3 + 1, qty())

        # ---------- 6 ----------
        print("\n[6] 수리 반납 - '폐기' 1개 (재고는 그대로여야 함)")
        client.rpc("add_repair_return", {
            "p_repair_id": repair_id, "p_returned_qty": 1, "p_returned_on": TODAY,
            "p_outcome": "폐기", "p_note": "검증용",
        }).execute()
        check("재고가 그대로다", START_QTY - 3 + 1, qty())
        check("반납 기록이 2건 쌓였다", 2, count("repair_returns", "repair_id", repair_id))

        # ---------- 7 ----------
        print("\n[7] 초과 반납 시도 - 보낸 3개 중 이미 2개 반납된 상태에서 5개 더 (거부돼야 함)")
        before = qty()
        rejected, message = False, ""
        try:
            client.rpc("add_repair_return", {
                "p_repair_id": repair_id, "p_returned_qty": 5, "p_returned_on": TODAY,
                "p_outcome": "정상복귀", "p_note": "초과 반납 검증",
            }).execute()
        except Exception as e:
            rejected = True
            message = getattr(e, "message", None) or str(e)
        check_true("DB가 초과 반납을 거부했다", rejected, f"응답: {message[:90]}")
        check("거부됐으므로 재고는 그대로다", before, qty())
        check("반납 기록도 안 늘었다", 2, count("repair_returns", "repair_id", repair_id))

    finally:
        # ---------- 뒷정리 ----------
        print("\n[뒷정리] 테스트로 만든 데이터를 지웁니다")
        mid = created["material_id"]
        if mid:
            try:
                for r in client.table("repairs").select("id").eq("material_id", mid).execute().data:
                    client.table("repair_returns").delete().eq("repair_id", r["id"]).execute()
                    client.table("repairs").delete().eq("id", r["id"]).execute()
                client.table("purchase_history").delete().eq("material_id", mid).execute()
                client.table("purchase_requests").delete().eq("material_id", mid).execute()
                client.table("history").delete().eq("material_id", mid).execute()
                client.table("materials").delete().eq("id", mid).execute()
                left = client.table("materials").select("id").eq("id", mid).execute().data
                print("       전부 정리됐습니다" if not left else f"       자재 id={mid}가 남아있습니다. 직접 지워주세요")
            except Exception as e:
                print(f"       정리 중 오류: {e}")
                print(f"       자재 id={mid} ('{TEST_PART_NAME}')를 직접 지워주세요")

    print("\n" + "=" * 74)
    failed = [n for n, ok, _ in results if not ok]
    for name, ok, detail in results:
        print(f"  [{'통과' if ok else '실패'}] {name}")
    print("=" * 74)
    if failed:
        print(f"{len(failed)}개 실패: {', '.join(failed)}")
        print("이 내용을 그대로 알려주시면 원인을 찾겠습니다.")
    else:
        print(f"전체 통과 ({len(results)}개 항목) - 3단계 수정이 실제 DB에서 정상 동작합니다.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
