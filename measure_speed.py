"""
앱이 느린 원인이 어디인지 실제로 재보는 스크립트입니다. 추측으로 고치지 않으려고 만들었습니다.

읽기만 합니다. 데이터를 바꾸거나 만들지 않습니다.
비밀번호는 화면에 안 보이게 입력받고 어디에도 저장하지 않습니다.
접속 정보는 앱이 쓰는 .streamlit/secrets.toml을 그대로 읽습니다.

실행:  python measure_speed.py
"""
import getpass
import statistics
import sys
import time
import tomllib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from supabase import create_client

from db import _load_all_rows  # 앱이 실제로 쓰는 병렬 페이지 로더

REPEAT = 3  # 한 항목당 몇 번 재서 중앙값을 쓸지 (네트워크가 튀는 것을 걸러내기 위함)


# db.py의 _load_all_rows와 같은 일을 하되, 페이지를 동시에 말고 하나씩 순서대로 가져옵니다.
# supabase 클라이언트가 HTTP/2를 쓰는데, HTTP/2는 요청을 TCP 연결 하나에 몰아넣습니다.
# 그래서 여러 스레드가 동시에 요청하면 같은 연결을 두고 충돌해서 오류가 날 수 있습니다.
# 이 방식이 실제로 얼마나 느린지(혹은 안 느린지) 재보려고 만들었습니다.
def load_all_rows_sequential(count_query_builder, data_query_builder, page_size=1000):
    total = count_query_builder().range(0, 0).execute().count or 0
    rows = []
    for start in range(0, total, page_size):
        rows.extend(data_query_builder().range(start, start + page_size - 1).execute().data)
    return rows


def measure(label, fn, note=""):
    """fn을 여러 번 실행해 중앙값(ms)을 돌려줍니다. 실패해도 다음 항목으로 넘어갑니다."""
    times, rows, error = [], 0, None
    for _ in range(REPEAT):
        start = time.perf_counter()
        try:
            result = fn()
        except Exception as e:
            error = f"{type(e).__name__}: {e}"
            break
        times.append((time.perf_counter() - start) * 1000)
        rows = len(result) if hasattr(result, "__len__") else 0

    if error:
        print(f"  {label:<34} {'실패':>8}        -     {error[:60]}")
        return {"label": label, "ms": None, "rows": 0, "error": error}

    ms = statistics.median(times)
    print(f"  {label:<34} {ms:>8.0f} ms   {rows:>6,}건  {note}")
    return {"label": label, "ms": ms, "rows": rows, "error": None}


def main():
    secrets_path = Path(__file__).parent / ".streamlit" / "secrets.toml"
    if not secrets_path.exists():
        sys.exit(f"secrets.toml을 찾을 수 없습니다: {secrets_path}")
    with open(secrets_path, "rb") as f:
        secrets = tomllib.load(f)

    client = create_client(secrets["supabase"]["url"], secrets["supabase"]["key"])

    print("=" * 82)
    print("앱 속도 측정 - 로그인해주세요 (읽기만 하며 데이터를 바꾸지 않습니다)")
    print("=" * 82)
    email = input("이메일: ").strip()
    password = getpass.getpass("비밀번호 (입력한 글자는 화면에 안 보입니다): ")
    try:
        auth = client.auth.sign_in_with_password({"email": email, "password": password})
    except Exception as e:
        sys.exit(f"\n로그인에 실패했습니다: {e}")
    client.postgrest.auth(auth.session.access_token)
    print(f"로그인 성공: {auth.user.email}\n")

    # 첫 요청은 연결을 새로 여느라 유독 느려서, 측정에서 빼기 위해 미리 한 번 부릅니다.
    client.table("materials").select("id").limit(1).execute()

    sample = client.table("history").select("equipment_id").not_.is_(
        "equipment_id", "null"
    ).limit(1).execute().data
    equip = sample[0]["equipment_id"] if sample else None
    print(f"시험용 설비 ID: {equip!r}\n")

    hist_count = client.table("history").select("id", count="exact").limit(1).execute().count
    mat_count = client.table("materials").select("id", count="exact").limit(1).execute().count
    print(f"정비이력 {hist_count:,}건 ({-(-hist_count // 1000)}페이지), "
          f"자재 {mat_count:,}건 ({-(-mat_count // 1000)}페이지)\n")

    def hist_builders():
        return (lambda: client.table("history").select("id", count="exact").order("id"),
                lambda: client.table("history").select("*, materials(part_name)").order("id"))

    def mat_builders():
        return (lambda: client.table("materials").select("id", count="exact").order("id"),
                lambda: client.table("materials").select("*").order("id"))

    print("[A] 어느 페이지를 열든 항상 실행되는 것 (맨 위 요약 카드)")
    m_par = measure("자재 전체 - 병렬(현재 방식)", lambda: _load_all_rows(*mat_builders()))
    m_seq = measure("자재 전체 - 순차", lambda: load_all_rows_sequential(*mat_builders()))
    m_cnt = measure("요약 카드 3개 한 번에 (dashboard_summary)",
                    lambda: client.rpc("dashboard_summary", {}).execute().data, "← 개선안")

    print("\n[B] BOQ 검색 화면")
    boq = measure("BOQ 한 건 검색 (find_boq)",
                  lambda: client.rpc("find_boq", {"p_search": "LM101 BD001"}).execute().data)
    h_par = measure("정비이력 전체 - 병렬(현재 방식)", lambda: _load_all_rows(*hist_builders()),
                    "← 여기서 오류가 날 수 있음")
    h_seq = measure("정비이력 전체 - 순차", lambda: load_all_rows_sequential(*hist_builders()))
    h_one = measure("설비 1개 이력만 조회", lambda: client.table("history").select(
        "*, materials(part_name)").eq("equipment_id", equip).eq("direction", "출고").execute().data,
        "← 개선안")

    print("\n[C] 병렬 로더 안정성 확인 (같은 호출을 5번 반복)")
    fails = 0
    for i in range(5):
        try:
            _load_all_rows(*hist_builders())
            print(f"  {i+1}회차: 성공")
        except Exception as e:
            fails += 1
            print(f"  {i+1}회차: 실패 - {type(e).__name__}")
    print(f"  → 5번 중 {fails}번 실패")

    # ---------------- 결론 ----------------
    print("\n" + "=" * 82)
    print("결론")
    print("=" * 82)

    if h_par["ms"] and h_seq["ms"]:
        diff = h_seq["ms"] - h_par["ms"]
        print(f"  병렬 vs 순차 (정비이력 {hist_count:,}건)")
        print(f"    병렬 {h_par['ms']:.0f} ms  /  순차 {h_seq['ms']:.0f} ms  "
              f"→ 순차가 {abs(diff):.0f} ms {'느림' if diff > 0 else '빠름'}")
        if abs(diff) < 300:
            print("    차이가 크지 않습니다. 오류 위험을 감수할 만큼의 이득이 아닙니다.")
    elif h_seq["ms"]:
        print(f"  병렬은 실패, 순차는 {h_seq['ms']:.0f} ms에 성공했습니다.")

    # '지금'은 앱이 실제로 쓰는 방식(병렬)으로 계산해야 합니다. 순차 값을 쓰면 개선폭이
    # 실제보다 부풀려집니다. 병렬이 실패했을 때만 순차 값으로 대신합니다.
    base = h_par["ms"] or h_seq["ms"]
    mat_now = m_par["ms"] or m_seq["ms"]
    if base and mat_now and m_cnt["ms"] and boq["ms"] and h_one["ms"]:
        now = mat_now + boq["ms"] + base
        after = m_cnt["ms"] + boq["ms"] + h_one["ms"]
        print(f"\n  BOQ 검색 화면 한 번 여는 비용 (캐시가 비어있을 때)")
        print(f"    지금      {now:>7.0f} ms  = 자재 {mat_now:.0f} + BOQ {boq['ms']:.0f} + 이력전체 {base:.0f}")
        print(f"    개선 후   {after:>7.0f} ms  = 요약 {m_cnt['ms']:.0f} + BOQ {boq['ms']:.0f} + 이력1건 {h_one['ms']:.0f}")
        print(f"    → {now / after:.1f}배 빨라짐 (약 {now - after:.0f} ms 절약)")

    print("\n  ※ 여기 값은 '서버에서 데이터를 가져오는 시간'입니다.")
    print("     Streamlit이 화면을 다시 그리는 비용은 빠져 있어, 실제 체감은 이보다 더 걸립니다.")
    print("=" * 82)
    return 0


if __name__ == "__main__":
    sys.exit(main())
