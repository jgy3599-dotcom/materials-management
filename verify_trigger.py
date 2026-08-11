"""
materials 수정 권한 트리거(restrict_material_update)가 실제로 도는지 확인하는 스크립트입니다.

왜 따로 있나
  verify_stage3.py를 통과했다고 이 트리거가 제대로 도는 건 아닙니다. 그 검사들은
  current_qty(현재재고)만 바꾸는데, 그 필드는 일반 권한도 허용이라 트리거가 권한을
  NULL로 잘못 읽어도 똑같이 통과합니다. 관리자 전용 필드를 실제로 고쳐봐야 확인됩니다.

무엇을 보나
  - 관리자가 '비고'·'표준재고'처럼 현재재고가 아닌 필드를 고칠 수 있는지
    (= 트리거가 auth.jwt()에서 권한을 제대로 읽는지)
  - 현재재고만 바꾸는 것도 여전히 되는지 (= 일반 사용자 출고 경로가 안 깨졌는지)

언제 돌리나
  restrict_material_update 함수나 materials의 RLS 정책을 건드렸을 때.
  특히 security definer / search_path 설정을 바꿨다면 반드시.

안전장치
  - 검증 전용 자재를 새로 만들어 그것만 건드립니다. 실제 자재는 손대지 않습니다.
  - 끝나면 만든 것을 지웁니다. 중간에 실패해도 지우려고 시도합니다.
  - 비밀번호는 화면에 안 보이게 입력받고 어디에도 저장하지 않습니다.

준비물
  - 관리자 계정
  - .streamlit/secrets.toml (verify_stage3.py가 읽는 것과 같은 파일)

실행:  python verify_trigger.py
"""
import getpass
import sys
import tomllib
from pathlib import Path

from supabase import create_client

TEST_PART_NAME = "__트리거검증용_임시자재__(자동삭제됨)"

results = []


def check(name, expected, actual):
    passed = expected == actual
    results.append((name, passed))
    print(f"  [{'통과' if passed else '실패'}] {name}   (기대 {expected!r} / 실제 {actual!r})")


def main():
    secrets_path = Path(__file__).parent / ".streamlit" / "secrets.toml"
    if not secrets_path.exists():
        sys.exit(f"secrets.toml을 찾을 수 없습니다: {secrets_path}")
    with open(secrets_path, "rb") as f:
        secrets = tomllib.load(f)

    client = create_client(secrets["supabase"]["url"], secrets["supabase"]["key"])

    print("=" * 70)
    print("트리거 검증 - 관리자 계정으로 로그인해주세요")
    print("=" * 70)
    email = input("이메일: ").strip()
    password = getpass.getpass("비밀번호 (입력한 글자는 화면에 안 보입니다): ")

    try:
        auth = client.auth.sign_in_with_password({"email": email, "password": password})
    except Exception as e:
        sys.exit(f"\n로그인에 실패했습니다: {e}")

    # 권한은 app_metadata에 있습니다(user_metadata는 본인이 고칠 수 있어 쓰지 않습니다).
    role = (auth.user.app_metadata or {}).get("role", "일반")
    # 이 줄이 없으면 이후 요청에 로그인 정보가 안 실려서 권한 검사가 엉뚱하게 돕니다.
    client.postgrest.auth(auth.session.access_token)
    print(f"\n로그인 성공: {auth.user.email}  (권한: {role})")
    if role != "관리자":
        sys.exit("관리자 계정이 아닙니다. 이 검증은 관리자로 해야 합니다.")

    material_id = None
    try:
        print("\n[준비] 검증용 자재를 하나 만듭니다")
        row = client.table("materials").insert({
            "category": "__검증용__",
            "part_name": TEST_PART_NAME,
            "current_qty": 10,
            "standard_qty": 10,
            "note": "처음값",
        }).execute()
        material_id = row.data[0]["id"]
        print(f"  만들었습니다 (id={material_id})")

        print("\n[1] 비고 고치기 - 트리거가 권한을 읽어야 통과합니다")
        client.table("materials").update({"note": "고친값"}).eq("id", material_id).execute()
        after = client.table("materials").select("note").eq("id", material_id).execute().data[0]
        check("비고가 바뀌었다", "고친값", after["note"])

        print("\n[2] 표준재고 고치기 - 이것도 관리자만 되는 필드입니다")
        client.table("materials").update({"standard_qty": 77}).eq("id", material_id).execute()
        after = client.table("materials").select("standard_qty").eq("id", material_id).execute().data[0]
        check("표준재고가 바뀌었다", 77, after["standard_qty"])

        print("\n[3] 현재재고만 고치기 - 일반 권한도 되는 필드입니다")
        client.rpc("adjust_material_qty", {"p_material_id": material_id, "p_delta": 5}).execute()
        after = client.table("materials").select("current_qty").eq("id", material_id).execute().data[0]
        check("현재재고가 15가 되었다", 15, after["current_qty"])

    finally:
        if material_id is not None:
            print("\n[뒷정리] 검증용 자재를 지웁니다")
            try:
                client.table("materials").delete().eq("id", material_id).execute()
                print("  지웠습니다")
            except Exception as e:
                print(f"  ⚠️ 못 지웠습니다. Supabase에서 '{TEST_PART_NAME}' 를 직접 지워주세요. ({e})")

    print("\n" + "=" * 70)
    failed = [n for n, ok in results if not ok]
    if failed:
        print(f"실패 {len(failed)}건: {', '.join(failed)}")
        sys.exit(1)
    print(f"전부 통과 ({len(results)}개). 트리거가 정상 동작합니다.")


if __name__ == "__main__":
    main()
