"""
지금 DB 상태를 파일로 떠둡니다. 나중에 되돌려야 할 때 쓰는 안전망입니다.

왜 필요한가
  materials(자재)에는 "언제 바뀌었는지"가 없습니다. 재고는 값이 덮어써지기 때문에,
  지금 값을 저장해두지 않으면 나중에 어디로 되돌려야 할지 알 방법이 없습니다.
  history(사용이력)도 등록 시각이 없어서, 지금 최대 id를 적어둬야 "이 뒤에 생긴 것"을
  가려낼 수 있습니다.

무엇을 남기는가
  - 테이블별 전체 내용 (CSV, 엑셀에서 바로 열립니다)
  - 테이블별 행 수와 최대 id (요약.txt)
  - 되돌리는 방법 (요약.txt)

읽기만 합니다. DB를 바꾸지 않습니다.

실행:  python snapshot_db.py
"""
import csv
import getpass
import sys
import tomllib
from datetime import datetime
from pathlib import Path

from supabase import create_client

# 사람이 바꾸는 표들입니다. boq는 설비 제원이라 거의 안 바뀌지만, 최상위권한자가
# 지울 수 있어서 같이 뜹니다.
TABLES = [
    "materials",          # ★ 재고. 값이 덮어써지므로 이게 제일 중요합니다.
    "history",            # 사용(출고) 이력
    "repairs",
    "repair_returns",
    "purchase_requests",
    "purchase_history",
    "boq",
    "audit_log",          # 최상위권한자만 읽을 수 있습니다. 권한이 없으면 건너뜁니다.
]


def fetch_all(client, table, page=1000):
    """Supabase는 한 번에 1,000행까지만 줍니다. 나눠서 전부 읽어옵니다."""
    rows, start = [], 0
    while True:
        chunk = (client.table(table).select("*")
                 .order("id").range(start, start + page - 1).execute().data)
        rows.extend(chunk)
        if len(chunk) < page:
            return rows
        start += page


def write_csv(path, rows):
    """엑셀에서 한글이 깨지지 않도록 utf-8-sig로 씁니다."""
    if not rows:
        path.write_text("(행 없음)\n", encoding="utf-8-sig")
        return
    # 행마다 컬럼이 다를 수 있으니(관계형이라 사실상 같지만) 전체를 훑어 모읍니다.
    fields = list(rows[0].keys())
    for r in rows:
        for k in r:
            if k not in fields:
                fields.append(k)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


def main():
    print("=" * 74)
    print("DB 스냅샷 - 지금 상태를 파일로 떠둡니다 (읽기 전용)")
    print("=" * 74)

    secrets_path = Path(__file__).parent / ".streamlit" / "secrets.toml"
    if not secrets_path.exists():
        sys.exit(f"secrets.toml을 찾을 수 없습니다: {secrets_path}")
    with open(secrets_path, "rb") as f:
        secrets = tomllib.load(f)

    client = create_client(secrets["supabase"]["url"], secrets["supabase"]["key"])
    print("\n로그인이 필요합니다.")
    email = input("  이메일: ").strip()
    password = getpass.getpass("  비밀번호: ")
    session = client.auth.sign_in_with_password({"email": email, "password": password})
    client.postgrest.auth(session.session.access_token)
    role = (session.user.app_metadata or {}).get("role", "일반")
    print(f"  로그인 성공 (권한: {role})\n")

    stamp = datetime.now().strftime("%Y-%m-%d_%H%M")
    out = Path(__file__).parent / "snapshots" / stamp
    out.mkdir(parents=True, exist_ok=True)

    summary = []
    for table in TABLES:
        try:
            rows = fetch_all(client, table)
        except Exception as e:
            print(f"  [건너뜀] {table:<20} {str(e)[:60]}")
            summary.append((table, None, None))
            continue

        write_csv(out / f"{table}.csv", rows)
        max_id = max((r["id"] for r in rows if r.get("id") is not None), default=None)
        print(f"  [저장] {table:<20} {len(rows):>6}행   최대 id: {max_id}")
        summary.append((table, len(rows), max_id))

    # 되돌릴 때 필요한 것을 한 파일에 적어둡니다. CSV만 있으면 "무엇이 새로 생긴 건지"를
    # 알 수 없어서, 최대 id를 반드시 같이 남겨야 합니다.
    lines = [
        f"DB 스냅샷  {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"뜬 사람: {email} (권한 {role})",
        "",
        "테이블별 상태",
        "-" * 50,
        f"{'테이블':<22}{'행 수':>8}{'최대 id':>12}",
    ]
    for table, n, max_id in summary:
        if n is None:
            lines.append(f"{table:<22}{'(못 읽음)':>8}")
        else:
            lines.append(f"{table:<22}{n:>8}{str(max_id):>12}")

    lines += [
        "",
        "",
        "되돌리는 방법",
        "=" * 50,
        "",
        "전체를 통째로 되돌리기보다, 아래 두 가지를 나눠서 하는 편이 안전합니다.",
        "",
        "1) 이 시점 뒤에 새로 생긴 행 지우기",
        "   각 표에서 위에 적힌 '최대 id'보다 큰 id가 그 뒤에 생긴 것입니다.",
        "   ⚠️ 지우는 순서가 중요합니다. 다른 표가 가리키고 있으면 DB가 거부합니다.",
        "      repair_returns → repairs → purchase_history → purchase_requests → history",
        "",
        "   예)  delete from repair_returns where id > <최대 id>;",
        "",
        "2) 재고(materials.current_qty) 되돌리기",
        "   materials.csv의 current_qty 값으로 되돌립니다. materials에는 시각 기록이",
        "   없어서, 이 파일이 유일한 근거입니다.",
        "",
        "   ⚠️ 재고를 직접 update 하면 '관리자가 아니면 current_qty 외에는 못 바꾼다'는",
        "      트리거(materials_restrict_update)에 걸릴 수 있습니다. 최상위권한자 계정으로",
        "      하거나 Supabase 대시보드의 SQL Editor에서 하세요.",
        "",
        "3) 순서 주의",
        "   1)을 먼저 하고 2)를 나중에 하세요. 반대로 하면 지우는 과정에서 delete_usage 등이",
        "   재고를 또 건드려 방금 맞춰놓은 값이 틀어집니다.",
        "   (SQL로 직접 delete 하면 함수를 안 거치므로 재고가 안 움직입니다. 앱에서 지우면",
        "    움직입니다 — 어느 쪽으로 할지 정하고 시작하세요.)",
        "",
        "",
        "이 스냅샷으로 알 수 없는 것",
        "=" * 50,
        "- 누가 언제 무엇을 바꿨는지: audit_log에 자재·출고이력 수정/삭제만 남습니다.",
        "- 이 시점 '이전'의 상태: 그건 이 파일이 아니라 Supabase 백업을 봐야 합니다.",
        "  (대시보드 Settings → Database → Backups. 플랜에 따라 있을 수도, 없을 수도 있습니다.)",
    ]
    (out / "요약.txt").write_text("\n".join(lines) + "\n", encoding="utf-8-sig")

    print("\n" + "-" * 74)
    print(f"저장 위치: {out}")
    print("되돌리는 방법은 그 폴더의 '요약.txt'에 적어뒀습니다.")
    print("-" * 74)


if __name__ == "__main__":
    main()
