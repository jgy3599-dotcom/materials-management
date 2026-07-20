import streamlit as st
import pandas as pd
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from supabase import create_client

# Supabase 테이블의 영문 컬럼명을 화면에 보여줄 한글 이름으로 바꿔주는 매핑표입니다.
MATERIAL_COLUMNS = {
    "id": "id",
    "warehouse_no": "창고번호",
    "category": "카테고리",
    "sub_type": "구분",
    "part_name": "부품명(규격)",
    "install_location": "설치위치",
    "manufacturer": "제조사",
    "vendor": "거래처",
    "in_use_qty": "적용수량",
    "standard_qty": "표준재고",
    "current_qty": "현재재고",
    "note": "비고",
}

# boq(설비 설계 사양) 테이블의 영문 컬럼명을 화면에 보여줄 한글 이름으로 바꿔주는 매핑표입니다.
BOQ_COLUMNS = {
    "conveyor_id": "컨베이어 ID",
    "category_large": "대분류",
    "category_mid": "중분류",
    "location_1": "위치1",
    "location_2": "위치2",
    "equipment_type": "설비구분",
    "conveyor_type": "컨베이어 종류",
    "length_mm": "길이(mm)",
    "width_mm": "폭(mm)",
    "angle": "각도",
    "belt_type": "벨트 종류",
    "belt_length": "벨트 규격",
    "motor_model": "모터 모델",
    "motor_type": "모터 종류",
    "motor_power": "모터 출력",
    "reducer_ratio": "감속비",
    "timing_chain": "타이밍벨트/체인",
    "remarks": "비고",
}


# Supabase 서버에 접속하는 연결 객체를 만듭니다.
# cache_resource로 감싸두면, 화면이 다시 그려질 때마다 매번 새로 연결하지 않고 재사용합니다.
# 이 클라이언트는 서버 전체에서 공유되므로, 로그인 세션이 실려있지 않은 "맨몸" 클라이언트입니다.
@st.cache_resource
def get_client():
    return create_client(st.secrets["supabase"]["url"], st.secrets["supabase"]["key"])


# 로그인한 사용자의 세션을 매 요청마다 다시 실어서 반환합니다.
# get_client()는 여러 사용자가 동시에 공유하는 클라이언트라서, 이걸 안 하면
# 다른 사람의 로그인 세션이 섞여버릴 수 있습니다. DB에 접근하는 함수들은 전부 이 함수를 씁니다.
def get_authed_client():
    client = get_client()
    if "access_token" in st.session_state:
        client.auth.set_session(st.session_state["access_token"], st.session_state["refresh_token"])
    return client


# Supabase는 한 번 요청에 최대 1000건까지만 돌려주므로, 1000건이 넘는 테이블은 여러 페이지로 나눠 가져와야 합니다.
# 페이지를 하나씩 순서대로 기다리면(예: 이력 5000여 건 = 6페이지) 왕복 시간이 그대로 쌓이므로,
# 전체 건수를 먼저 확인한 뒤 모든 페이지를 동시에(병렬로) 요청해서 가장 느린 페이지 하나만큼의 시간만 걸리게 합니다.
# count_query_builder/data_query_builder는 인자 없이 호출하면 매번 새 쿼리를 만들어주는 함수입니다.
# 건수 확인에는 count="exact"가 필요하지만, 실제 데이터 페이지를 가져올 때마다 매번 다시 세면
# 페이지 수만큼(예: 6번) 불필요하게 반복 계산하게 되므로 건수는 딱 한 번만 확인합니다.
def _load_all_rows(count_query_builder, data_query_builder, page_size=1000):
    total = count_query_builder().range(0, 0).execute().count or 0
    if total == 0:
        return []
    starts = range(0, total, page_size)

    def fetch_page(start):
        return data_query_builder().range(start, start + page_size - 1).execute().data

    with ThreadPoolExecutor(max_workers=len(starts)) as executor:
        pages = executor.map(fetch_page, starts)
    rows = []
    for page in pages:
        rows.extend(page)
    return rows


# materials 테이블 전체를 가져와서 한글 컬럼명이 붙은 표로 만들어줍니다.
# 화면 하나를 그릴 때 이 함수가 여러 탭에서 반복 호출되는데, cache_data로 감싸두면
# 15초 안의 반복 호출은 네트워크를 다시 안 타고 캐시된 결과를 재사용해서 훨씬 빨라집니다.
@st.cache_data(ttl=60)
def load_materials():
    supabase = get_authed_client()
    rows = _load_all_rows(
        lambda: supabase.table("materials").select("id", count="exact").order("id"),
        lambda: supabase.table("materials").select("*").order("id"),
    )
    df = pd.DataFrame(rows, columns=MATERIAL_COLUMNS.keys())
    return df.rename(columns=MATERIAL_COLUMNS)


# history 테이블을 가져오면서, 연결된 자재의 부품명도 같이 붙여서 보여줍니다.
# materials와 마찬가지로, 여러 페이지가 필요하면 동시에 병렬로 가져옵니다.
@st.cache_data(ttl=60)
def load_history():
    supabase = get_authed_client()
    data = _load_all_rows(
        lambda: supabase.table("history").select("id", count="exact").order("id"),
        lambda: supabase.table("history").select("*, materials(part_name)").order("id"),
    )

    rows = [
        {
            "일자": row["occurred_on"],
            "구분": row["direction"],
            "부품명(규격)": row["materials"]["part_name"] if row.get("materials") else None,
            "수량": row["quantity"],
            "담당자": row["manager"],
            "설비ID": row["equipment_id"],
            "문제": row["problem"],
            "조치": row["action_taken"],
            "부품메모": row["part_memo"],
            "비고": row["note"],
        }
        for row in data
    ]
    return pd.DataFrame(rows, columns=["일자", "구분", "부품명(규격)", "수량", "담당자", "설비ID", "문제", "조치", "부품메모", "비고"])


# 컨베이어 ID로 BOQ(설비 설계 사양) 한 건을 찾습니다. conveyor_id가 테이블에서 유일하므로 최대 한 건만 나옵니다.
@st.cache_data(ttl=60)
def get_boq(conveyor_id):
    res = get_authed_client().table("boq").select("*").eq("conveyor_id", conveyor_id).execute()
    if not res.data:
        return None
    df = pd.DataFrame(res.data, columns=BOQ_COLUMNS.keys())
    return df.rename(columns=BOQ_COLUMNS)


# 특정 설비(컨베이어)의 교체(사용/출고) 이력만 가져옵니다. BOQ 검색 화면에서 씁니다.
@st.cache_data(ttl=60)
def get_equipment_history(equipment_id):
    res = get_authed_client().table("history").select("*, materials(part_name)") \
        .eq("equipment_id", equipment_id).eq("direction", "출고").order("occurred_on", desc=True).execute()
    rows = [
        {
            "일자": row["occurred_on"],
            "부품명(규격)": row["materials"]["part_name"] if row.get("materials") else None,
            "수량": row["quantity"],
            "담당자": row["manager"],
            "문제": row["problem"],
            "조치": row["action_taken"],
            "부품메모": row["part_memo"],
            "비고": row["note"],
        }
        for row in res.data
    ]
    return pd.DataFrame(rows, columns=["일자", "부품명(규격)", "수량", "담당자", "문제", "조치", "부품메모", "비고"])


# 표준재고에서 현재재고를 뺀 값(구매필요 수량)을 매번 다시 계산해서 표에 붙여줍니다.
def with_구매필요(df):
    result = df.copy()
    result["구매필요"] = result["표준재고"] - result["현재재고"]
    return result


def insert_material(data):
    get_authed_client().table("materials").insert(data).execute()
    load_materials.clear()


def get_material(material_id):
    res = get_authed_client().table("materials").select("*").eq("id", material_id).execute()
    return res.data[0] if res.data else None


def update_material(material_id, data):
    get_authed_client().table("materials").update(data).eq("id", material_id).execute()
    load_materials.clear()


def delete_material(material_id):
    get_authed_client().table("materials").delete().eq("id", material_id).execute()
    load_materials.clear()


def insert_history(data):
    res = get_authed_client().table("history").insert(data).execute()
    load_history.clear()
    return res.data[0]["id"]


def update_material_qty(material_id, new_qty):
    get_authed_client().table("materials").update({"current_qty": new_qty}).eq("id", material_id).execute()
    load_materials.clear()


# 관리자가 자재를 수정/삭제할 때마다 남기는 감사 로그입니다.
def insert_audit_log(actor_email, action, material_id, part_name, before_data, after_data=None):
    get_authed_client().table("audit_log").insert({
        "actor_email": actor_email,
        "action": action,
        "material_id": material_id,
        "part_name": part_name,
        "before_data": before_data,
        "after_data": after_data,
    }).execute()


def load_audit_log():
    res = get_authed_client().table("audit_log").select("*").order("id", desc=True).limit(200).execute()
    df = pd.DataFrame(res.data)
    # before_data/after_data는 자재 한 행 전체를 담은 중첩된 JSON이라, 표로 그릴 때
    # 화면 렌더링 라이브러리가 다루기 어려워할 수 있어 문자열로 바꿔서 안전하게 보여줍니다.
    for col in ("before_data", "after_data"):
        if col in df.columns:
            df[col] = df[col].astype(str)
    return df


def _now():
    return datetime.now(timezone.utc).isoformat()


# 구매 요청 목록을 자재 부품명 + 표준재고/현재재고와 함께 가져옵니다.
@st.cache_data(ttl=15)
def load_purchase_requests():
    res = get_authed_client().table("purchase_requests").select(
        "*, materials(part_name, standard_qty, current_qty)"
    ).order("id", desc=True).execute()
    rows = [
        {
            "id": row["id"],
            "부품명(규격)": row["materials"]["part_name"] if row.get("materials") else None,
            "material_id": row["material_id"],
            "표준재고": row["materials"]["standard_qty"] if row.get("materials") else None,
            "현재재고": row["materials"]["current_qty"] if row.get("materials") else None,
            "요청수량": row["requested_qty"],
            "상태": row["status"],
            "요청자": row["requester_email"],
            "요청사유": row["request_note"],
            "반려사유": row["reject_reason"],
            "거래업체": row["vendor"],
            "단가": row["unit_price"],
            "입고수량": row["received_qty"],
            "요청일시": row["requested_at"],
        }
        for row in res.data
    ]
    return pd.DataFrame(rows, columns=[
        "id", "부품명(규격)", "material_id", "표준재고", "현재재고", "요청수량", "상태", "요청자",
        "요청사유", "반려사유", "거래업체", "단가", "입고수량", "요청일시",
    ])


# 같은 자재에 아직 끝나지 않은(입고완료/반려 아닌) 구매요청이 몇 건 있는지 셉니다.
# 중복 요청 방지용 경고 문구에 씁니다.
def count_open_requests_for_material(material_id):
    res = get_authed_client().table("purchase_requests").select("status").eq("material_id", material_id).execute()
    return sum(1 for row in res.data if row["status"] not in ("입고완료", "반려됨"))


def insert_purchase_request(material_id, requested_qty, requester_email, request_note):
    get_authed_client().table("purchase_requests").insert({
        "material_id": material_id,
        "requested_qty": requested_qty,
        "requester_email": requester_email,
        "request_note": request_note or None,
        "status": "요청됨",
    }).execute()
    load_purchase_requests.clear()


def start_review(request_id):
    get_authed_client().table("purchase_requests").update({
        "status": "검토중", "reviewed_at": _now(),
    }).eq("id", request_id).execute()
    load_purchase_requests.clear()


def approve_request(request_id, requested_qty):
    # 검토 중에 실제로 필요한 수량이 다르다고 판단되면, 승인하면서 요청수량 자체를 고쳐 반영합니다.
    get_authed_client().table("purchase_requests").update({
        "status": "승인됨", "approved_at": _now(), "requested_qty": requested_qty,
    }).eq("id", request_id).execute()
    load_purchase_requests.clear()


def reject_request(request_id, reason):
    get_authed_client().table("purchase_requests").update({
        "status": "반려됨", "rejected_at": _now(), "reject_reason": reason,
    }).eq("id", request_id).execute()
    load_purchase_requests.clear()


def mark_purchasing(request_id, vendor, unit_price):
    get_authed_client().table("purchase_requests").update({
        "status": "구매중", "purchased_at": _now(), "vendor": vendor, "unit_price": unit_price,
    }).eq("id", request_id).execute()
    load_purchase_requests.clear()


# 입고 처리: 요청 상태를 '입고완료'로 바꾸고, 실제 재고에 반영하면서 구매이력에도 한 줄 남깁니다.
# 구매이력은 이후 이 구매요청이 삭제되더라도 지워지지 않고 그대로 남습니다.
def receive_request(request_id, material_id, received_qty, vendor, unit_price):
    material = get_material(material_id)
    new_qty = int(material["current_qty"] or 0) + received_qty
    update_material_qty(material_id, new_qty)

    get_authed_client().table("purchase_history").insert({
        "material_id": material_id,
        "quantity": received_qty,
        "vendor": vendor,
        "unit_price": unit_price,
        "received_on": date.today().isoformat(),
        "request_id": request_id,
    }).execute()
    load_purchase_history.clear()

    get_authed_client().table("purchase_requests").update({
        "status": "입고완료", "received_at": _now(), "received_qty": received_qty,
    }).eq("id", request_id).execute()
    load_purchase_requests.clear()


# 구매요청을 삭제합니다. 이미 입고완료 상태였다면, 그때 반영했던 재고 증가분을 되돌립니다(원복).
# 구매이력에 남긴 기록은 지우지 않고, 대신 취소일시만 채워서 나중에 취소된 구매라는 걸 알 수 있게 합니다.
def delete_purchase_request(request_id):
    res = get_authed_client().table("purchase_requests").select("*").eq("id", request_id).execute()
    if not res.data:
        return
    row = res.data[0]

    if row["status"] == "입고완료" and row.get("received_qty"):
        material = get_material(row["material_id"])
        reverted_qty = int(material["current_qty"] or 0) - int(row["received_qty"])
        update_material_qty(row["material_id"], reverted_qty)
        get_authed_client().table("purchase_history").update({
            "reverted_at": _now(),
        }).eq("request_id", request_id).execute()
        load_purchase_history.clear()

    get_authed_client().table("purchase_requests").delete().eq("id", request_id).execute()
    load_purchase_requests.clear()


# 구매이력 목록을 자재 부품명과 함께 가져옵니다. 입고완료된 구매가 실제로 쌓이는,
# 삭제되지 않는 영구 기록입니다.
@st.cache_data(ttl=15)
def load_purchase_history():
    res = get_authed_client().table("purchase_history").select(
        "*, materials(part_name)"
    ).order("id", desc=True).execute()
    rows = [
        {
            "id": row["id"],
            "부품명(규격)": row["materials"]["part_name"] if row.get("materials") else None,
            "수량": row["quantity"],
            "거래업체": row["vendor"],
            "단가": row["unit_price"],
            "입고일": row["received_on"],
            "구매요청ID": row["request_id"],
            "취소일시": row["reverted_at"],
        }
        for row in res.data
    ]
    return pd.DataFrame(rows, columns=["id", "부품명(규격)", "수량", "거래업체", "단가", "입고일", "구매요청ID", "취소일시"])
