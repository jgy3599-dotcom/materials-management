"""
materials 수정 권한 트리거(restrict_material_update)가 실제로 도는지 확인하는 스크립트입니다.

왜 따로 있나
  verify_stage3.py를 통과했다고 이 트리거가 제대로 도는 건 아닙니다. 그 검사들은
  current_qty(현재재고)만 바꾸는데, 그 필드는 일반 권한도 허용이라 트리거가 권한을
  NULL로 잘못 읽어도 똑같이 통과합니다.

무엇을 보나
  [1][2] 관리자가 '비고'·'표준재고'처럼 현재재고가 아닌 필드를 고칠 수 있는가
  [3]    일반 권한이 그 필드들을 고치려 하면 막히는가        ← ★ 핵심
  [4]    일반 권한도 현재재고는 바꿀 수 있는가 (출고 경로가 안 깨졌는지)

  ⚠️ [3]이 이 스크립트의 존재 이유입니다. 관리자가 되는 것만 보면, 트리거를
  user_metadata로 되돌리거나(그 칸은 본인이 고칠 수 있어 취약합니다) 트리거를
  통째로 지워버려도 전부 통과가 뜹니다. 관리자 계정은 어느 쪽이든 통과하니까요.
  그래서 일반 계정으로 "막히는지"를 반드시 확인해야 합니다.

언제 돌리나
  restrict_material_update 함수나 materials의 RLS 정책을 건드렸을 때.
  특히 security definer / search_path / 권한을 읽는 칸을 바꿨다면 반드시.

안전장치
  - 검증 전용 자재를 새로 만들어 그것만 건드립니다. 실제 자재는 손대지 않습니다.
  - 끝나면 지우고, 실제로 지워졌는지까지 확인합니다.
  - 비밀번호는 화면에 안 보이게 입력받고 어디에도 저장하지 않습니다.

준비물
  - 관리자 계정
  - 일반 계정 (공용 계정). 없으면 건너뛸 수 있지만 [3][4]는 검사되지 않습니다.
  - .streamlit/secrets.toml (verify_stage3.py가 읽는 것과 같은 파일)

실행:  python verify_trigger.py
"""
import getpass
import sys
import tomllib
from pathlib import Path

from supabase import create_client

TEST_PART_NAME = "__트리거검증용_임시자재__(자동삭제됨)"
RESTRICTED_MESSAGE = "일반 권한은 현재재고만 수정할 수 있습니다"

results = []


def check(name, expected, actual):
    passed = expected == actual
    results.append((name, passed))
    print(f"  [{'통과' if passed else '실패'}] {name}   (기대 {expected!r} / 실제 {actual!r})")


def check_true(name, condition, detail=""):
    results.append((name, bool(condition)))
    print(f"  [{'통과' if condition else '실패'}] {name}   {detail}")
    return bool(condition)


def expect_rejected(name, action, must_contain):
    """DB가 거부해야 하는 동작을 시험합니다.

    ⚠️ '오류가 났으니 통과'로 처리하면 안 됩니다. 트리거가 사라져서 나는 오류든
    네트워크 오류든 전부 예외입니다. 그걸 통과로 세면 검사하려던 방어가 없는데도
    통과가 뜹니다. 그래서 오류 메시지가 그 방어의 문구인지까지 확인합니다.
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
    """.data[0]을 안전하게 꺼냅니다. 행이 없으면 실패로 기록하고 None을 돌려줍니다."""
    if not response.data:
        check_true(f"{what}(행이 있어야 함)", False, "행이 하나도 없습니다")
        return None
    return response.data[0]


def login(url, key, label):
    """로그인해서 (client, role)을 돌려줍니다. 실패하면 None, None."""
    email = input(f"{label} 이메일: ").strip()
    if not email:
        return None, None
    password = getpass.getpass(f"{label} 비밀번호 (화면에 안 보입니다): ")

    client = create_client(url, key)
    try:
        auth = client.auth.sign_in_with_password({"email": email, "password": password})
    except Exception as e:
        print(f"  로그인에 실패했습니다: {e}")
        return None, None

    # 권한은 app_metadata에 있습니다(user_metadata는 본인이 고칠 수 있어 쓰지 않습니다).
    role = (auth.user.app_metadata or {}).get("role", "일반")
    client.postgrest.auth(auth.session.access_token)
    print(f"  로그인 성공: {auth.user.email} (권한: {role})")
    return client, role


def main():
    secrets_path = Path(__file__).parent / ".streamlit" / "secrets.toml"
    if not secrets_path.exists():
        sys.exit(f"secrets.toml을 찾을 수 없습니다: {secrets_path}")
    with open(secrets_path, "rb") as f:
        secrets = tomllib.load(f)
    url, key = secrets["supabase"]["url"], secrets["supabase"]["key"]

    print("=" * 74)
    print("트리거 검증")
    print("=" * 74)
    print("\n[로그인 1/2] 관리자 계정")
    admin, admin_role = login(url, key, "  관리자")
    if admin is None:
        sys.exit("관리자 로그인이 필요합니다.")
    if admin_role != "관리자":
        sys.exit(f"이 계정의 권한이 '{admin_role}'입니다. 관리자 계정으로 해주세요.")

    print("\n[로그인 2/2] 일반 계정 (공용 계정)")
    print("  ★ 이 검사가 이 스크립트의 핵심입니다. 건너뛰면 트리거가 사라져도 통과가 뜹니다.")
    print("  건너뛰려면 이메일 칸에서 그냥 엔터를 치세요.")
    normal, normal_role = login(url, key, "  일반")
    if normal is not None and normal_role == "관리자":
        print("  ⚠️ 이 계정도 관리자입니다. 일반 계정이 아니면 [3]을 검사할 수 없습니다.")
        normal = None

    material_id = None
    try:
        print("\n[준비] 검증용 자재를 하나 만듭니다")
        row = one_row(admin.table("materials").insert({
            "category": "__검증용__",
            "part_name": TEST_PART_NAME,
            "current_qty": 10,
            "standard_qty": 10,
            "note": "처음값",
        }).execute(), "만든 자재")
        if row is None:
            raise RuntimeError("검증용 자재를 만들지 못했습니다.")
        material_id = row["id"]
        print(f"  만들었습니다 (id={material_id})")

        print("\n[1] 관리자가 비고 고치기 (되어야 함)")
        admin.table("materials").update({"note": "고친값"}).eq("id", material_id).execute()
        after = one_row(admin.table("materials").select("note").eq("id", material_id).execute(), "자재")
        if after:
            check("비고가 바뀌었다", "고친값", after["note"])

        print("\n[2] 관리자가 표준재고 고치기 (되어야 함)")
        admin.table("materials").update({"standard_qty": 77}).eq("id", material_id).execute()
        after = one_row(admin.table("materials").select("standard_qty").eq("id", material_id).execute(), "자재")
        if after:
            check("표준재고가 바뀌었다", 77, after["standard_qty"])

        if normal is None:
            print("\n[3][4] 일반 계정을 안 받아서 건너뜁니다")
            check_true("일반 권한 차단을 확인했다", False,
                       "일반 계정 없이 돌려서 확인하지 못했습니다 (이게 핵심 검사입니다)")
        else:
            print("\n[3] 일반 권한이 비고를 고치려 하면 막히는가 (★ 핵심)")
            expect_rejected(
                "트리거가 일반 권한의 비고 수정을 막았다",
                lambda: normal.table("materials").update({"note": "일반이_고침"})
                              .eq("id", material_id).execute(),
                RESTRICTED_MESSAGE)
            after = one_row(admin.table("materials").select("note").eq("id", material_id).execute(), "자재")
            if after:
                check("비고가 안 바뀌었다", "고친값", after["note"])

            print("\n[4] 일반 권한이 현재재고는 바꿀 수 있는가 (출고 경로)")
            normal.rpc("adjust_material_qty",
                       {"p_material_id": material_id, "p_delta": 5}).execute()
            after = one_row(admin.table("materials").select("current_qty").eq("id", material_id).execute(), "자재")
            if after:
                check("현재재고가 15가 되었다", 15, after["current_qty"])

    except Exception as e:
        # ⚠️ 이 except를 빼지 마세요. 없으면 오류가 그대로 밖으로 나가서 뒷정리는 되지만
        # 아래 결과 요약에 도달하지 못하고, 초보자에게는 오류 덩어리만 보입니다.
        detail = f"{type(e).__name__}: {getattr(e, 'message', None) or e}"
        print(f"\n  [실패] 검사 도중 오류가 나서 중단했습니다   {detail}")
        results.append(("검사가 끝까지 진행됐다", False))

    finally:
        if material_id is not None:
            print("\n[뒷정리] 검증용 자재를 지웁니다")
            try:
                admin.table("materials").delete().eq("id", material_id).execute()
                # ⚠️ 지웠는지 반드시 다시 읽어서 확인합니다. 권한 정책에 막힌 DELETE는
                # 오류가 아니라 "0건 처리"로 조용히 넘어갑니다. 확인 없이 "지웠습니다"를
                # 찍으면, 검증용 자재가 실제 목록에 영원히 남습니다.
                left = admin.table("materials").select("id").eq("id", material_id).execute().data
                if left:
                    print(f"  ⚠️ 안 지워졌습니다. Supabase에서 '{TEST_PART_NAME}' 를 직접 지워주세요.")
                    print("     (materials 삭제 권한 정책이 망가졌을 수 있습니다)")
                else:
                    print("  지웠습니다")
            except Exception as e:
                print(f"  ⚠️ 못 지웠습니다. Supabase에서 '{TEST_PART_NAME}' 를 직접 지워주세요. ({e})")

    print("\n" + "=" * 74)
    failed = [n for n, ok in results if not ok]
    if failed:
        print(f"실패 {len(failed)}건: {', '.join(failed)}")
        sys.exit(1)
    print(f"전부 통과 ({len(results)}개). 트리거가 정상 동작합니다.")


if __name__ == "__main__":
    main()
