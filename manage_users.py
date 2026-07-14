"""
동료 계정에 권한(role)을 부여하는 관리자 전용 도구입니다.
Streamlit 앱과는 별개로, 터미널에서 직접 실행합니다: python manage_users.py

Supabase의 "service_role 키"가 필요합니다 (Supabase 대시보드 → Settings → API → service_role).
이 키는 절대 secrets.toml이나 GitHub에 올리면 안 되는, 가장 강력한 키입니다.
그래서 이 스크립트는 실행할 때마다 화면에 직접 입력받고, 어디에도 저장하지 않습니다.
"""
import getpass
from supabase import create_client

SUPABASE_URL = "https://qapyzbcjrzditfvpccoj.supabase.co"

service_role_key = getpass.getpass("Supabase service_role 키를 붙여넣으세요 (입력한 글자는 화면에 안 보여요): ").strip()
client = create_client(SUPABASE_URL, service_role_key)

email = input("권한을 설정할 사용자 이메일: ").strip()
role = input("권한 (관리자 / 일반): ").strip()

if role not in ("관리자", "일반"):
    print("권한은 '관리자' 또는 '일반'만 입력할 수 있습니다.")
    raise SystemExit(1)

users = client.auth.admin.list_users()
target = next((u for u in users if u.email == email), None)

if not target:
    print(f"'{email}' 계정을 찾을 수 없습니다. Supabase 대시보드에서 계정을 먼저 만들어주세요.")
    raise SystemExit(1)

client.auth.admin.update_user_by_id(target.id, {"user_metadata": {"role": role}})
print(f"'{email}' 계정의 권한을 '{role}'로 설정했습니다.")
