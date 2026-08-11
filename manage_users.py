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

# list_users()는 넘겨주지 않으면 첫 페이지(50명)만 돌려줍니다. 계정이 그보다 많으면
# 실제로 있는 사람도 "찾을 수 없습니다"가 떠서, 관리자가 중복 계정을 새로 만들게 됩니다.
users = []
page = 1
while True:
    batch = client.auth.admin.list_users(page=page, per_page=200)
    if not batch:
        break
    users.extend(batch)
    if len(batch) < 200:
        break
    page += 1

# GoTrue는 이메일을 소문자로 저장합니다. 입력에 대문자가 섞여도 찾도록 양쪽을 맞춥니다.
target = next((u for u in users if (u.email or "").lower() == email.lower()), None)

if not target:
    print(f"'{email}' 계정을 찾을 수 없습니다. Supabase 대시보드에서 계정을 먼저 만들어주세요.")
    print(f"(전체 {len(users)}개 계정을 확인했습니다.)")
    raise SystemExit(1)

# ⚠️ user_metadata가 아니라 app_metadata에 씁니다. user_metadata는 로그인한 본인이
# 브라우저에서 supabase.auth.updateUser({ data: { role: "관리자" } }) 한 줄로 고칠 수
# 있어서, 거기에 권한을 두면 일반 계정이 스스로 관리자가 됩니다.
# app_metadata는 지금 쓰고 있는 service_role 키로만 쓸 수 있습니다.
# DB 권한 정책과 web/js/auth.js도 같은 칸을 봅니다. 한쪽만 바꾸면 어긋납니다.
client.auth.admin.update_user_by_id(target.id, {"app_metadata": {"role": role}})
print(f"'{target.email}' 계정의 권한을 '{role}'로 설정했습니다.")
print("이 사람이 이미 로그인 중이라면, 로그아웃 후 다시 로그인해야 반영됩니다.")
