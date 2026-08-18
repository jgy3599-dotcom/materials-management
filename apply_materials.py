# -*- coding: utf-8 -*-
"""
Mega-Hub 부품관리(최신).xlsx 대조 결과 중 '안전한 5건'만 DB에 반영합니다.
  · 신규 자재 2건 등록 (벨트류)
  · 기본정보 3건 수정 (설치위치 / 창고번호 / 비고)

재고(current_qty)는 한 칸도 건드리지 않습니다.

실행:  python apply_materials.py

먼저 "무엇을 바꿀지"만 보여주고 멈춥니다. 확인한 뒤 yes 를 쳐야 실제로 바뀝니다.
한 번 더 돌려도 이미 반영된 건은 건너뜁니다(두 번 들어가지 않습니다).

⚠️ 이건 1회용입니다. 2026-08-18 최신본 대조에서 나온 5건만 들어 있어서, 다 반영한
뒤에는 지우세요. 나중에 필요하면 git 이력에서 꺼낼 수 있습니다
(migrate_role_to_app_metadata.py 때와 같은 방식).
CLAUDE.md의 "파이썬 스크립트는 셋뿐" 규칙에 이 파일은 포함되지 않습니다.
"""
import getpass
import sys
import tomllib
from pathlib import Path

from supabase import create_client

# ---------------------------------------------------------------- 반영할 내용
# 신규 등록. 원본 '자재 현황(벨트류)' 201행 / 205행 그대로입니다.
NEW_MATERIALS = [
    dict(category="벨트류",
         part_name="골 벨트 (metering용 780 * 2660용)",
         sub_type="이송벨트",
         install_location="2층 중형라인 metering (잉여벨트 사용)",
         in_use_qty=139, standard_qty=0, current_qty=0),
    dict(category="벨트류",
         part_name="100 * 10,000",
         sub_type="이송벨트",
         install_location="이송벨트 보수용 벨트",
         in_use_qty=0, standard_qty=0, current_qty=0,
         vendor="하바지트 코리아(XVT-2094)"),
]

# 기본정보 수정. (카테고리, 부품명)으로 찾아 한 칸만 바꿉니다.
UPDATES = [
    dict(category="전기", part_name="NZ2EHG-T8N",
         field="install_location",
         old="Inductrial Ethernet Switch",
         new="CP/EP/ED Inductrial Ethernet Switch"),
    dict(category="전기", part_name="15형 VIA-T150M-PT 산업용 터치모니터",
         field="warehouse_no",
         old=None,
         new="72"),
    dict(category="외산(TAMS)", part_name="Power supply 24-28V AC/DC",
         field="note",
         old=None,
         new="모델명 : QT40"),
]


def find_secrets():
    for base in (Path.cwd(), Path(__file__).resolve().parent):
        p = base / ".streamlit" / "secrets.toml"
        if p.exists():
            return p
    sys.exit("secrets.toml을 찾을 수 없습니다. C:\\project 폴더에서 실행해주세요.")


def login():
    with open(find_secrets(), "rb") as f:
        secrets = tomllib.load(f)
    client = create_client(secrets["supabase"]["url"], secrets["supabase"]["key"])
    print("=" * 74)
    print("자재 반영 - 관리자 계정으로 로그인해주세요")
    print("=" * 74)
    email = input("이메일: ").strip()
    password = getpass.getpass("비밀번호 (입력한 글자는 화면에 안 보입니다): ")
    try:
        auth = client.auth.sign_in_with_password({"email": email, "password": password})
    except Exception as e:
        sys.exit("\n로그인에 실패했습니다: %s" % e)
    role = (auth.user.app_metadata or {}).get("role", "일반")
    client.postgrest.auth(auth.session.access_token)
    print("\n로그인 성공: %s (권한: %s)" % (auth.user.email, role))
    if role != "관리자":
        sys.exit("관리자 계정이 필요합니다. 일반 권한은 현재재고만 바꿀 수 있습니다.")
    return client


def fetch(client, category, part_name):
    r = (client.table("materials").select("*")
         .eq("category", category).eq("part_name", part_name).execute())
    return r.data or []


def plan(client):
    """무엇을 바꿀지만 계산해서 돌려준다. DB는 건드리지 않는다."""
    inserts, updates, skips, problems = [], [], [], []

    for m in NEW_MATERIALS:
        hit = fetch(client, m["category"], m["part_name"])
        if hit:
            skips.append("등록: %s — 이미 있음 (id %s)"
                         % (m["part_name"], ", ".join(str(h["id"]) for h in hit)))
        else:
            inserts.append(m)

    for u in UPDATES:
        hit = fetch(client, u["category"], u["part_name"])
        if len(hit) == 0:
            problems.append("수정: %s / %s — DB에서 못 찾음"
                            % (u["category"], u["part_name"]))
            continue
        if len(hit) > 1:
            problems.append("수정: %s / %s — 같은 이름이 %d개라 어느 것인지 알 수 없음 (id %s)"
                            % (u["category"], u["part_name"], len(hit),
                               ", ".join(str(h["id"]) for h in hit)))
            continue
        row = hit[0]
        cur = row.get(u["field"])
        if cur == u["new"]:
            skips.append("수정: %s.%s — 이미 '%s'" % (u["part_name"], u["field"], u["new"]))
        elif cur not in (None, "", u["old"]):
            problems.append("수정: %s.%s — DB에 예상 밖의 값이 있음. 지금 '%s' → 넣으려던 값 '%s'"
                            % (u["part_name"], u["field"], cur, u["new"]))
        else:
            updates.append(dict(id=row["id"], now=cur, **u))
    return inserts, updates, skips, problems


def show(inserts, updates, skips, problems):
    print("\n" + "=" * 74)
    print("이렇게 바꿉니다 (아직 아무것도 안 바꿨습니다)")
    print("=" * 74)
    print("\n[신규 등록 %d건]" % len(inserts))
    for m in inserts:
        print("  + %s / %s" % (m["category"], m["part_name"]))
        print("      구분=%s  설치위치=%s" % (m.get("sub_type"), m.get("install_location")))
        print("      적용수량=%s  표준재고=%s  현재재고=%s  취급점=%s"
              % (m["in_use_qty"], m["standard_qty"], m["current_qty"], m.get("vendor")))
    print("\n[기본정보 수정 %d건]" % len(updates))
    for u in updates:
        print("  ~ id %s  %s / %s" % (u["id"], u["category"], u["part_name"]))
        print("      %s : %r  ->  %r" % (u["field"], u["now"], u["new"]))
    if skips:
        print("\n[건너뜀 %d건 — 이미 반영돼 있음]" % len(skips))
        for s in skips:
            print("  · %s" % s)
    if problems:
        print("\n[!! 손대지 않음 %d건 — 사람이 봐야 합니다]" % len(problems))
        for p in problems:
            print("  !! %s" % p)
    print("\n재고(current_qty)는 신규 등록분 말고는 건드리지 않습니다.")


def apply(client, inserts, updates):
    print("\n" + "=" * 74)
    print("반영 중")
    print("=" * 74)
    for m in inserts:
        r = client.table("materials").insert(m).execute()
        print("  등록 완료  id %s  %s" % (r.data[0]["id"], m["part_name"]))
    for u in updates:
        client.table("materials").update({u["field"]: u["new"]}).eq("id", u["id"]).execute()
        back = client.table("materials").select(u["field"]).eq("id", u["id"]).execute()
        got = back.data[0][u["field"]]
        ok = "확인됨" if got == u["new"] else "!! 값이 다릅니다: %r" % got
        print("  수정 완료  id %s  %s = %r  (%s)" % (u["id"], u["field"], u["new"], ok))


def main():
    client = login()
    inserts, updates, skips, problems = plan(client)
    show(inserts, updates, skips, problems)
    if not inserts and not updates:
        print("\n바꿀 것이 없습니다. 끝냅니다.")
        return
    print("\n" + "-" * 74)
    ans = input("위 내용대로 반영할까요? 하려면 yes 를 그대로 쳐주세요: ").strip()
    if ans != "yes":
        print("취소했습니다. 아무것도 바꾸지 않았습니다.")
        return
    apply(client, inserts, updates)
    print("\n끝났습니다.")


if __name__ == "__main__":
    main()
