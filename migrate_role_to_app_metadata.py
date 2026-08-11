"""
계정 권한을 user_metadata → app_metadata로 옮기는 1회용 스크립트입니다. (2026-08-11)

왜 옮기나
  user_metadata는 로그인한 본인이 브라우저에서 한 줄로 고칠 수 있는 칸입니다.
      await supabase.auth.updateUser({ data: { role: "관리자" } })
  접속 키는 사이트에 공개되어 있으므로(공개용 키라 그 자체는 정상), 권한을 그 칸에
  두면 일반 계정이 스스로 관리자가 됩니다. app_metadata는 service_role 키로만 쓸 수
  있어서 본인이 못 고칩니다.

순서 (이 순서를 지켜주세요)
  1) 이 스크립트 실행          ← 권한을 새 칸에 복사 (아직 아무도 안 읽으니 무해)
  2) supabase_setup.sql의 정책·트리거를 Supabase에서 실행  ← 여기서 구멍이 막힘
  3) 웹 배포 (auth.js)
  4) 모두 로그아웃 후 다시 로그인  ← 새 칸은 새로 받은 신분증에만 들어 있습니다

안전장치
  - 무엇을 바꿀지 먼저 전부 보여주고, 확인을 받은 뒤에만 씁니다.
  - user_metadata는 지우지 않고 그대로 둡니다(되돌려야 할 때를 위해).
  - service_role 키는 실행할 때마다 입력받고 어디에도 저장하지 않습니다.

실행:  python migrate_role_to_app_metadata.py
"""
import getpass
import sys

from supabase import create_client

SUPABASE_URL = "https://qapyzbcjrzditfvpccoj.supabase.co"
VALID_ROLES = ("관리자", "일반")


def fetch_all_users(client):
    """list_users()는 기본 50명만 돌려주므로 끝까지 넘겨가며 모읍니다."""
    users, page = [], 1
    while True:
        batch = client.auth.admin.list_users(page=page, per_page=200)
        if not batch:
            break
        users.extend(batch)
        if len(batch) < 200:
            break
        page += 1
    return users


def main():
    print("=" * 74)
    print("계정 권한을 app_metadata로 옮깁니다 (1회용)")
    print("=" * 74)
    key = getpass.getpass("Supabase service_role 키 (입력한 글자는 화면에 안 보입니다): ").strip()
    if not key:
        sys.exit("키가 비어 있습니다.")

    client = create_client(SUPABASE_URL, key)
    users = fetch_all_users(client)
    print(f"\n계정 {len(users)}개를 찾았습니다.\n")

    plan = []
    for u in users:
        old = (u.user_metadata or {}).get("role")
        already = (u.app_metadata or {}).get("role")
        # 권한이 안 적혀 있거나 이상한 값이면 '일반'으로 확정해 둡니다.
        # (앱도 권한이 없으면 '일반'으로 보므로 판단이 달라지지 않습니다.)
        new = old if old in VALID_ROLES else "일반"
        plan.append((u, old, already, new))

    print(f"{'이메일':<38} {'지금(옛칸)':<12} {'새칸':<10} {'→ 넣을 값'}")
    print("-" * 74)
    for u, old, already, new in plan:
        mark = "" if already == new else "  ←바뀜"
        print(f"{(u.email or '?'):<38} {str(old):<12} {str(already):<10} {new}{mark}")

    admins = [u.email for u, _, _, new in plan if new == "관리자"]
    print("\n" + "=" * 74)
    print(f"관리자가 될 계정 {len(admins)}개: {', '.join(admins) if admins else '(없음)'}")
    print("=" * 74)
    print("\n⚠️ 위 관리자 목록이 맞는지 꼭 확인하세요.")
    print("   여기 빠진 사람은 다음 단계 이후 관리자 기능을 못 씁니다.")

    answer = input("\n이대로 진행할까요? (yes 를 입력하면 실행): ").strip()
    if answer != "yes":
        sys.exit("취소했습니다. 아무것도 바꾸지 않았습니다.")

    changed = 0
    for u, _, already, new in plan:
        if already == new:
            continue
        client.auth.admin.update_user_by_id(u.id, {"app_metadata": {"role": new}})
        print(f"  {u.email} → {new}")
        changed += 1

    print(f"\n완료했습니다. {changed}개 계정을 바꿨습니다.")
    print("\n다음 단계:")
    print("  2) supabase_setup.sql의 권한 정책·트리거를 Supabase에서 실행")
    print("  3) 웹 배포")
    print("  4) 모두 로그아웃 후 다시 로그인")


if __name__ == "__main__":
    main()
