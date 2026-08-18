"""
DB 쪽 업무 규칙(SQL 함수 4개 + 권한 트리거)이 실제로 제대로 도는지 확인합니다.
**SQL 함수나 RLS 정책, 권한 트리거를 건드렸으면 이걸 돌리세요.**

무엇을 보나
  [1][2]   출고 등록 - 한진 자재만 재고 차감, 수리 건 자동 생성
  [2-1]    출고 수량 음수 거부
  [3]      구매요청 입고 - 재고 증가 + 구매이력 + 상태 변경이 한 묶음
  [3-1~4]  입고 방어 - 수량 0 / 자재 불일치 / 두 번 입고 / 반려된 요청
  [4]      구매요청 삭제 - 재고 원복 + 구매이력은 취소표시만
  [5][6]   수리 반납 - 정상복귀만 재고 복구, 폐기는 안 함
  [7][8]   반납 방어 - 초과 반납 / 잘못된 결과값
  [9]      자재 수정 권한 - 일반 권한은 현재재고만 바꿀 수 있는가

  ⚠️ [9]의 일반 권한 검사가 특히 중요합니다. 나머지 검사는 전부 current_qty만
  바꾸는데 그 필드는 일반 권한도 허용이라, 권한 트리거가 통째로 사라져도 다 통과합니다.

안전장치
  - 테스트 전용 자재를 새로 하나 만들어서 그것으로만 시험합니다. 실제 자재는 건드리지 않습니다.
  - 끝나면 만든 것을 전부 지웁니다. 중간에 실패해도 지우려고 시도합니다.
  - 비밀번호는 화면에 안 보이게 입력받고, 어디에도 저장하지 않습니다.

준비물
  - 관리자 계정. 구매요청 처리와 뒷정리에 관리자 권한이 필요합니다.
  - 일반 계정(공용). 없으면 건너뛸 수 있지만 [9-3][9-4]는 검사되지 않습니다.
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
created = {"material_id": None}


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


def expect_rejected(name, action, must_contain):
    """DB가 거부해야 하는 동작을 시험합니다.

    ⚠️ '오류가 났으니 통과'로 처리하면 안 됩니다. 함수가 삭제되거나 이름이 바뀌면
    (PGRST202 '함수를 찾을 수 없음'), 토큰이 만료되면, 네트워크가 끊기면 — 전부
    오류입니다. 그걸 통과로 세면 검사하려던 방어가 아예 없는데도 전체 통과가 뜹니다.
    그래서 오류 메시지가 그 방어의 문구인지까지 확인합니다.
    """
    try:
        action()
    except Exception as e:
        message = getattr(e, "message", None) or str(e)
        if must_contain in message:
            return check_true(name, True, f"거부 사유: {message[:70]}")
        return check_true(name, False,
                          f"거부는 됐지만 다른 이유입니다. '{must_contain}'가 없음: {message[:70]}")
    return check_true(name, False, "거부되지 않고 그냥 통과했습니다 (방어가 없습니다)")


def one_row(response, what):
    """.data[0]을 안전하게 꺼냅니다.

    행이 없으면 IndexError로 죽는 대신 실패로 기록하고 None을 돌려줍니다. 없어지는
    상황이 바로 이 스크립트가 잡으려는 버그라, 거기서 죽으면 요약도 못 보고 뒤쪽
    검사도 통째로 건너뛰게 됩니다.
    """
    if not response.data:
        check_true(f"{what}(행이 있어야 함)", False, "행이 하나도 없습니다")
        return None
    return response.data[0]


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

    # 권한은 app_metadata에 있습니다(user_metadata는 본인이 고칠 수 있어 쓰지 않습니다).
    role = (auth.user.app_metadata or {}).get("role", "일반")
    client.postgrest.auth(auth.session.access_token)
    print(f"\n로그인 성공: {auth.user.email} (권한: {role})")
    if role != "관리자":
        sys.exit("관리자 계정이 필요합니다. 구매요청 처리와 뒷정리를 할 수 없습니다.")

    # ---- 일반 계정 (선택) ----
    # [9]에서 "일반 권한이 막히는가"를 보려면 실제 일반 계정이 필요합니다.
    # ⚠️ 관리자로만 확인하면, 권한 트리거를 통째로 지워도 전부 통과가 뜹니다.
    # 관리자는 어차피 제한 대상이 아니기 때문입니다.
    print("\n[선택] 일반 계정(공용 계정)으로도 로그인하면 권한 트리거까지 검사합니다.")
    print("  ★ 건너뛰면 '일반 권한이 막히는가'를 확인할 수 없어 실패로 기록됩니다.")
    print("  건너뛰려면 이메일 칸에서 그냥 엔터를 치세요.")
    normal = None
    normal_email = input("  일반 계정 이메일: ").strip()
    if normal_email:
        normal_password = getpass.getpass("  일반 계정 비밀번호 (화면에 안 보입니다): ")
        try:
            n_auth = normal_client_auth = create_client(
                secrets["supabase"]["url"], secrets["supabase"]["key"])
            n = n_auth.auth.sign_in_with_password(
                {"email": normal_email, "password": normal_password})
            n_role = (n.user.app_metadata or {}).get("role", "일반")
            normal_client_auth.postgrest.auth(n.session.access_token)
            print(f"  로그인 성공: {n.user.email} (권한: {n_role})")
            if n_role == "관리자":
                print("  ⚠️ 이 계정도 관리자입니다. 일반 계정이 아니면 [9-3]을 검사할 수 없습니다.")
            else:
                normal = normal_client_auth
        except Exception as e:
            print(f"  일반 계정 로그인에 실패했습니다: {e}")

    def qty():
        """테스트 자재의 현재재고를 DB에서 다시 읽어옵니다."""
        r = client.table("materials").select("current_qty").eq("id", created["material_id"]).execute()
        return r.data[0]["current_qty"]

    def count(table, column, value):
        r = client.table(table).select("id", count="exact").eq(column, value).execute()
        return r.count or 0

    def qty_of(material_id):
        """자재 하나의 현재재고를 읽어옵니다. [10]에서 자재를 갈아탈 때 씁니다."""
        r = client.table("materials").select("current_qty").eq("id", material_id).execute()
        return r.data[0]["current_qty"] if r.data else None

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

        # 수리 건이 "어느 출고에서 나왔는지"를 들고 있어야 합니다. 이게 비어 있으면
        # 나중에 그 출고를 고치거나 지울 때 어느 수리 건인지 찾을 수 없습니다.
        # 자재·수량·날짜로 추측하면 안 됩니다 - 같은 날 같은 자재를 같은 수량으로
        # 두 번 출고한 기록이 실제로 있습니다(2026-06-22 Tail DRUM 2건).
        rep = client.table("repairs").select("history_id").eq(
            "material_id", mid).execute().data
        hist = client.table("history").select("id").eq(
            "material_id", mid).eq("direction", "출고").execute().data
        check("수리 건에 출고 이력 번호가 들어갔다",
              hist[0]["id"] if hist else None,
              rep[0]["history_id"] if rep else None)

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

        # ---------- 2-1 ----------
        # 화면은 min="1" required로 막지만 이 RPC는 로그인한 사람 전체에게 열려 있습니다.
        # 음수가 통과하면 "현재재고 - (-5)"가 되어 재고가 오히려 늘고, quantity가 음수인
        # 수리 건까지 생겨 그 건은 이후 반납이 영구히 불가능해집니다.
        print("\n[2-1] 출고 수량 음수 시도 (거부돼야 함)")
        expect_rejected(
            "DB가 음수 출고를 거부했다",
            lambda: client.rpc("register_usage", {
                "p_occurred_on": TODAY, "p_material_id": mid, "p_quantity": -5,
                "p_manager": "한진 SPARE", "p_note": "음수 검증", "p_equipment_id": None,
                "p_problem": None, "p_action_taken": None, "p_part_memo": None,
                "p_deduct_stock": True,
            }).execute(),
            "수량은 1개 이상")
        check("거부됐으므로 재고는 그대로다", START_QTY - 3, qty())
        check("이력도 안 늘었다", 2, count("history", "material_id", mid))

        # ---------- 3 ----------
        print("\n[3] 구매요청 -> 입고 처리 5개 (재고가 늘고 구매이력이 남아야 함)")
        req = client.table("purchase_requests").insert({
            "material_id": mid, "requested_qty": 5, "status": "구매중",
            "requester_email": auth.user.email, "vendor": "검증용업체", "unit_price": 1000,
        }).execute()
        # 뒷정리는 material_id로 지우므로 요청 id를 created에 담아둘 필요가 없습니다.
        rid = req.data[0]["id"]

        # 아직 '구매중' 상태입니다. 입고가 성공하기 전에 방어 두 개를 먼저 시험합니다.
        print("\n[3-1] 입고 수량 0 시도 (거부돼야 함)")
        expect_rejected(
            "DB가 0개 입고를 거부했다",
            lambda: client.rpc("receive_purchase_request", {
                "p_request_id": rid, "p_material_id": mid, "p_received_qty": 0,
                "p_vendor": "검증용업체", "p_unit_price": 1000, "p_received_on": TODAY,
            }).execute(),
            "입고 수량은 1개 이상")

        # 요청에 적힌 자재와 다른 자재로 입고하면, 삭제(원복)는 요청 행의 자재를
        # 되돌리므로 A는 영구히 늘고 B는 영구히 주는 어긋남이 생깁니다.
        print("\n[3-2] 다른 자재로 입고 시도 (거부돼야 함)")
        expect_rejected(
            "DB가 자재 불일치를 거부했다",
            lambda: client.rpc("receive_purchase_request", {
                "p_request_id": rid, "p_material_id": -1, "p_received_qty": 5,
                "p_vendor": "검증용업체", "p_unit_price": 1000, "p_received_on": TODAY,
            }).execute(),
            "요청에 적힌 자재와 다른 자재")
        check("거부됐으므로 재고는 그대로다", START_QTY - 3, qty())

        client.rpc("receive_purchase_request", {
            "p_request_id": rid, "p_material_id": mid, "p_received_qty": 5,
            "p_vendor": "검증용업체", "p_unit_price": 1000, "p_received_on": TODAY,
        }).execute()
        check("재고가 5개 늘었다", START_QTY - 3 + 5, qty())
        check("구매이력이 1줄 생겼다", 1, count("purchase_history", "material_id", mid))
        req_row = one_row(
            client.table("purchase_requests").select("status").eq("id", rid).execute(),
            "구매요청")
        if req_row:
            check("요청 상태가 바뀌었다", "입고완료", req_row["status"])

        # ---------- 3-3 ----------
        # 화면 새로고침이 실패해 행이 '구매중'으로 남으면 관리자가 다시 누릅니다.
        # 막지 않으면 재고가 두 배로 들어가고 구매이력도 두 건 생깁니다.
        print("\n[3-3] 같은 요청 두 번 입고 시도 (거부돼야 함)")
        expect_rejected(
            "DB가 두 번째 입고를 거부했다",
            lambda: client.rpc("receive_purchase_request", {
                "p_request_id": rid, "p_material_id": mid, "p_received_qty": 5,
                "p_vendor": "검증용업체", "p_unit_price": 1000, "p_received_on": TODAY,
            }).execute(),
            "이미 입고 처리된 요청")
        check("재고가 두 배로 안 늘었다", START_QTY - 3 + 5, qty())
        check("구매이력도 안 늘었다", 1, count("purchase_history", "material_id", mid))

        # ---------- 3-4 ----------
        # A가 구매중 행의 팝업을 열어둔 사이 B가 반려하면, A의 화면에는 입고 버튼이
        # 그대로 보입니다. '입고완료'만 막으면 반려된 건의 재고가 들어갑니다.
        print("\n[3-4] 반려된 요청 입고 시도 (거부돼야 함)")
        rejected_req = client.table("purchase_requests").insert({
            "material_id": mid, "requested_qty": 3, "status": "반려됨",
            "requester_email": auth.user.email, "reject_reason": "검증용",
        }).execute()
        rejected_rid = rejected_req.data[0]["id"]
        expect_rejected(
            "DB가 반려된 요청의 입고를 거부했다",
            lambda: client.rpc("receive_purchase_request", {
                "p_request_id": rejected_rid, "p_material_id": mid, "p_received_qty": 3,
                "p_vendor": "검증용업체", "p_unit_price": 1000, "p_received_on": TODAY,
            }).execute(),
            "구매중인 요청만")
        check("반려 건으로 재고가 안 늘었다", START_QTY - 3 + 5, qty())
        client.table("purchase_requests").delete().eq("id", rejected_rid).execute()

        # ---------- 4 ----------
        print("\n[4] 그 구매요청 삭제 (재고는 원복, 구매이력은 남되 취소표시)")
        client.rpc("remove_purchase_request", {"p_request_id": rid}).execute()
        check("재고가 원복됐다", START_QTY - 3, qty())
        check("구매이력은 안 지워졌다", 1, count("purchase_history", "material_id", mid))
        # order by를 붙입니다. 여러 건이면 어느 행이 올지 정해져 있지 않아, 정렬이
        # 없으면 엉뚱한 행의 reverted_at을 보고 판정할 수 있습니다.
        ph = one_row(
            client.table("purchase_history").select("reverted_at")
                  .eq("material_id", mid).order("id").execute(),
            "구매이력")
        if ph:
            check_true("구매이력에 취소일시가 채워졌다",
                       ph["reverted_at"] is not None, f"reverted_at={ph['reverted_at']}")
        check("구매요청은 삭제됐다", 0, count("purchase_requests", "id", rid))

        # ---------- 5·6·7 ----------
        # 1번에서 만들어진 수리 건이 있어야 아래 셋을 할 수 있습니다. 없으면(=1번이
        # 이미 실패한 상황) 죽지 않고 건너뛰어, 요약까지는 볼 수 있게 합니다.
        repair_row = one_row(
            client.table("repairs").select("id").eq("material_id", mid).order("id").execute(),
            "수리 건")
        if repair_row is None:
            print("\n[5~7] 수리 건이 없어 건너뜁니다 (1번을 먼저 확인하세요)")
        else:
            repair_id = repair_row["id"]

            print(f"\n[5] 수리 반납 - '정상복귀' 1개 (재고가 늘어야 함)  수리건 id={repair_id}")
            client.rpc("add_repair_return", {
                "p_repair_id": repair_id, "p_returned_qty": 1, "p_returned_on": TODAY,
                "p_outcome": "정상복귀", "p_note": "검증용",
            }).execute()
            check("재고가 1개 늘었다", START_QTY - 3 + 1, qty())

            print("\n[6] 수리 반납 - '폐기' 1개 (재고는 그대로여야 함)")
            client.rpc("add_repair_return", {
                "p_repair_id": repair_id, "p_returned_qty": 1, "p_returned_on": TODAY,
                "p_outcome": "폐기", "p_note": "검증용",
            }).execute()
            check("재고가 그대로다", START_QTY - 3 + 1, qty())
            check("반납 기록이 2건 쌓였다", 2, count("repair_returns", "repair_id", repair_id))

            # ⚠️ 여기서 요청하는 수량이 2개인 것이 중요합니다. 보낸 3개 중 이미 2개가
            # 반납된 상태라 2+2=4 > 3 이라 거부돼야 합니다. 예전에는 5개를 요청했는데,
            # 그러면 5 > 3 이라서 "이미 반납한 양"을 아예 안 세는 엉터리 구현도 통과했습니다.
            # 진짜 방어(이미반납 + 이번요청 > 보낸수량)를 시험하려면 2개여야 합니다.
            print("\n[7] 초과 반납 시도 - 보낸 3개 중 이미 2개 반납된 상태에서 2개 더 (거부돼야 함)")
            before = qty()
            expect_rejected(
                "DB가 초과 반납을 거부했다",
                lambda: client.rpc("add_repair_return", {
                    "p_repair_id": repair_id, "p_returned_qty": 2, "p_returned_on": TODAY,
                    "p_outcome": "정상복귀", "p_note": "초과 반납 검증",
                }).execute(),
                "보낸 수량")
            check("거부됐으므로 재고는 그대로다", before, qty())
            check("반납 기록도 안 늘었다", 2, count("repair_returns", "repair_id", repair_id))

            # 재고 복구는 '정상복귀'일 때만 하는데, 목록의 반납 합계는 결과와 상관없이
            # 전부 더합니다. 그래서 엉뚱한 값이 들어오면 "재고는 안 돌아왔는데 화면에는
            # 복귀완료"인 상태가 됩니다.
            print("\n[8] 반납 결과에 엉뚱한 값 시도 (거부돼야 함)")
            expect_rejected(
                "DB가 잘못된 반납 결과를 거부했다",
                lambda: client.rpc("add_repair_return", {
                    "p_repair_id": repair_id, "p_returned_qty": 1, "p_returned_on": TODAY,
                    "p_outcome": "정상복구", "p_note": "오타 검증",
                }).execute(),
                "반납 결과는 정상복귀 또는 폐기")
            check("반납 기록이 여전히 2건이다", 2, count("repair_returns", "repair_id", repair_id))

        # ---------- 9 ----------
        # materials 수정 권한 트리거(restrict_material_update)입니다. 일반 권한은
        # 현재재고만 바꿀 수 있고 나머지 칸은 못 건드려야 합니다.
        #
        # ⚠️ 위 검사들은 전부 current_qty만 바꾸는데, 그 필드는 일반 권한도 허용이라
        # 트리거가 권한을 잘못 읽어도(또는 트리거가 아예 없어도) 똑같이 통과합니다.
        # 그래서 관리자 전용 필드를 실제로 고쳐봐야 확인됩니다.
        print("\n[9] 자재 수정 권한 트리거")

        print("  [9-1] 관리자가 비고 고치기 (되어야 함)")
        client.table("materials").update({"note": "고친값"}).eq("id", mid).execute()
        row = one_row(client.table("materials").select("note").eq("id", mid).execute(), "자재")
        if row:
            check("관리자는 비고를 고칠 수 있다", "고친값", row["note"])

        print("  [9-2] 관리자가 표준재고 고치기 (되어야 함)")
        client.table("materials").update({"standard_qty": 77}).eq("id", mid).execute()
        row = one_row(client.table("materials").select("standard_qty").eq("id", mid).execute(), "자재")
        if row:
            check("관리자는 표준재고를 고칠 수 있다", 77, row["standard_qty"])

        if normal is None:
            print("  [9-3][9-4] 일반 계정을 안 받아서 건너뜁니다")
            check_true("일반 권한 차단을 확인했다", False,
                       "일반 계정 없이 돌려서 확인하지 못했습니다 (이게 핵심 검사입니다)")
        else:
            print("  [9-3] 일반 권한이 비고를 고치려 하면 막히는가 (★ 핵심)")
            expect_rejected(
                "트리거가 일반 권한의 비고 수정을 막았다",
                lambda: normal.table("materials").update({"note": "일반이_고침"})
                              .eq("id", mid).execute(),
                "일반 권한은 현재재고만 수정할 수 있습니다")
            row = one_row(client.table("materials").select("note").eq("id", mid).execute(), "자재")
            if row:
                check("비고가 안 바뀌었다", "고친값", row["note"])

            print("  [9-4] 일반 권한도 현재재고는 바꿀 수 있는가 (출고 경로)")
            before = qty()
            normal.rpc("adjust_material_qty", {"p_material_id": mid, "p_delta": 5}).execute()
            check("일반 권한이 현재재고를 5 늘렸다", before + 5, qty())

        # ---------- 10 ----------
        # 출고 이력 수정(update_usage)입니다. 자재·출처·수량을 바꾸면 재고가 두 군데서
        # 움직이고 수리 건도 따라가야 합니다. 화면에서 나눠 부르면 중간에 끊겼을 때
        # 재고만 바뀌고 이력은 그대로인 상태가 생기므로 DB 함수 하나로 묶여 있습니다.
        print("\n[10] 출고 이력 수정")

        made_b = client.table("materials").insert({
            "category": "검증용", "part_name": TEST_PART_NAME + "_B",
            "current_qty": START_QTY, "standard_qty": 0,
            "note": "verify_stage3.py가 만든 임시 자재입니다. 남아있으면 지워도 됩니다.",
        }).execute()
        created["material_id_b"] = one_row(made_b, "임시 자재 B")["id"]
        mid_b = created["material_id_b"]

        # 고칠 대상을 하나 등록합니다. 한진이므로 재고가 1 깎이고 수리 건이 생깁니다.
        q0 = qty()
        client.rpc("register_usage", {
            "p_occurred_on": TODAY, "p_material_id": mid, "p_quantity": 1,
            "p_manager": "한진 SPARE", "p_note": "수정검증", "p_equipment_id": "TEST-EQ",
            "p_problem": "수정검증", "p_action_taken": None, "p_part_memo": None,
            "p_deduct_stock": True,
        }).execute()
        target = one_row(
            client.table("history").select("id").eq("material_id", mid)
                  .eq("direction", "출고").order("id", desc=True).limit(1).execute(),
            "수정할 출고 이력")
        hid = target["id"] if target else None

        def edit(**over):
            args = {"p_id": hid, "p_occurred_on": TODAY, "p_material_id": mid,
                    "p_quantity": 1, "p_manager": "한진 SPARE", "p_note": "수정검증",
                    "p_equipment_id": "TEST-EQ", "p_problem": "수정검증",
                    "p_action_taken": None, "p_part_memo": None}
            args.update(over)
            return client.rpc("update_usage", args).execute()

        print("  [10-1] 수량 1 -> 3 (재고가 2 더 줄어야 함)")
        edit(p_quantity=3)
        check("수량을 늘리면 그 차이만큼 재고가 준다", q0 - 3, qty())

        print("  [10-2] 출처를 '보우'로 (재고 원복 + 수리 건 삭제)")
        edit(p_quantity=3, p_manager="보우")
        check("한진에서 보우로 바꾸면 재고가 원복된다", q0, qty())
        check("딸린 수리 건이 사라졌다", 0, count("repairs", "history_id", hid))

        print("  [10-3] 자재를 B로 (옛 자재는 늘고 새 자재는 줄어야 함)")
        edit(p_quantity=1, p_manager="한진 SPARE")          # 다시 한진 (q0-1)
        edit(p_quantity=1, p_manager="한진 SPARE", p_material_id=mid_b)
        check("옛 자재 재고가 되돌아왔다", q0, qty())
        check("새 자재 재고가 1 줄었다", START_QTY - 1, qty_of(mid_b))

        # [10-2]에서 보우로 바꾸며 지워졌던 수리 건이, 다시 한진이 되면서 살아나야 합니다.
        # 재고를 안 깎던 출처 -> 깎는 출처로 바뀐 경우입니다(실수로 보우로 등록했다가
        # 고치는 상황). 옛 상태도 한진이었으면 만들지 않으므로, 이관분은 안 늘어납니다.
        print("  [10-7] 보우 -> 한진으로 되돌리면 수리 건이 살아나는가")
        check("수리 건이 다시 생겼다", 1, count("repairs", "history_id", hid))
        rep_back = one_row(
            client.table("repairs").select("material_id,quantity").eq("history_id", hid).execute(),
            "되살아난 수리 건")
        if rep_back:
            check("되살아난 수리 건이 바뀐 자재를 가리킨다", mid_b, rep_back["material_id"])

        print("  [10-5] 수량 0 시도 (거부돼야 함)")
        expect_rejected(
            "DB가 수량 0을 거부했다",
            lambda: edit(p_quantity=0, p_material_id=mid_b),
            "수량은 1개 이상이어야 합니다")

        if normal is None:
            print("  [10-6] 일반 계정을 안 받아서 건너뜁니다")
            check_true("일반 권한의 출고 수정 차단을 확인했다", False,
                       "일반 계정 없이 돌려서 확인하지 못했습니다 (이게 핵심 검사입니다)")
        else:
            print("  [10-6] 일반 권한이 고치려 하면 막히는가 (★ 핵심)")
            expect_rejected(
                "일반 권한의 출고 수정이 막혔다",
                lambda: normal.rpc("update_usage", {
                    "p_id": hid, "p_occurred_on": TODAY, "p_material_id": mid_b,
                    "p_quantity": 2, "p_manager": "한진 SPARE", "p_note": "일반이_고침",
                    "p_equipment_id": "TEST-EQ", "p_problem": "수정검증",
                    "p_action_taken": None, "p_part_memo": None,
                }).execute(),
                "관리자만 출고 이력을 고칠 수 있습니다")

        print("  [10-4] 수리 반납이 등록된 건 (수정이 거부돼야 함)")
        # ⚠️ 위 hid는 쓸 수 없습니다. [10-2]에서 출처를 보우로 바꾸며 수리 건이 지워졌고,
        #    [10-3]에서 다시 한진으로 되돌려도 수리 건은 안 돌아옵니다("없으면 새로 만들지
        #    않는다"는 규칙 때문). 그래서 반납을 걸 수리 건이 없습니다.
        #    반납 검사는 수리 건이 살아 있는 새 출고로 해야 합니다.
        client.rpc("register_usage", {
            "p_occurred_on": TODAY, "p_material_id": mid_b, "p_quantity": 1,
            "p_manager": "한진 구매품", "p_note": "반납검증", "p_equipment_id": "TEST-EQ",
            "p_problem": "반납검증", "p_action_taken": None, "p_part_memo": None,
            "p_deduct_stock": True,
        }).execute()
        held = one_row(
            client.table("history").select("id").eq("material_id", mid_b)
                  .eq("direction", "출고").order("id", desc=True).limit(1).execute(),
            "반납 검사용 출고 이력")
        rep = one_row(
            client.table("repairs").select("id")
                  .eq("history_id", held["id"] if held else -1).execute(),
            "반납 검사용 수리 건")
        if held and rep:
            client.rpc("add_repair_return", {
                "p_repair_id": rep["id"], "p_returned_qty": 1, "p_returned_on": TODAY,
                "p_outcome": "정상복귀", "p_note": "반납검증",
            }).execute()
            expect_rejected(
                "반납이 등록된 건은 수정이 거부됐다",
                lambda: client.rpc("update_usage", {
                    "p_id": held["id"], "p_occurred_on": TODAY, "p_material_id": mid_b,
                    "p_quantity": 2, "p_manager": "한진 구매품", "p_note": "반납검증",
                    "p_equipment_id": "TEST-EQ", "p_problem": "반납검증",
                    "p_action_taken": None, "p_part_memo": None,
                }).execute(),
                "수리 반납이 등록되어 있어")

    except Exception as e:
        # ⚠️ 이 except를 빼지 마세요. 없으면 오류가 그대로 밖으로 나가서, 뒷정리는
        # 되지만 아래 결과 요약에 도달하지 못합니다. 정작 진단이 필요한 순간에
        # "N개 실패: ..." 대신 오류 덩어리만 보이게 됩니다.
        detail = f"{type(e).__name__}: {getattr(e, 'message', None) or e}"
        print(f"\n  [실패] 검사 도중 오류가 나서 중단했습니다   {detail}")
        results.append(("검사가 끝까지 진행됐다", False, detail))

    finally:
        # ---------- 뒷정리 ----------
        print("\n[뒷정리] 테스트로 만든 데이터를 지웁니다")
        # [10]에서 자재 B를 하나 더 만들고 출고를 B로 갈아타므로, 둘 다 지워야 합니다.
        left_ids = []
        for mid in (created["material_id"], created.get("material_id_b")):
            if not mid:
                continue
            try:
                for r in client.table("repairs").select("id").eq("material_id", mid).execute().data:
                    client.table("repair_returns").delete().eq("repair_id", r["id"]).execute()
                    client.table("repairs").delete().eq("id", r["id"]).execute()
                client.table("purchase_history").delete().eq("material_id", mid).execute()
                client.table("purchase_requests").delete().eq("material_id", mid).execute()
                client.table("history").delete().eq("material_id", mid).execute()
                client.table("materials").delete().eq("id", mid).execute()
                if client.table("materials").select("id").eq("id", mid).execute().data:
                    left_ids.append(mid)
            except Exception as e:
                print(f"       정리 중 오류(자재 id={mid}): {e}")
                left_ids.append(mid)
        print("       전부 정리됐습니다" if not left_ids
              else f"       자재 id={left_ids}가 남아있습니다. 직접 지워주세요")

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
