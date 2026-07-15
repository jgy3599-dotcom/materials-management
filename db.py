import streamlit as st
import pandas as pd
from datetime import date, datetime, timezone
from supabase import create_client

# Supabase 테이블의 영문 컬럼명을 화면에 보여줄 한글 이름으로 바꿔주는 매핑표입니다.
MATERIAL_COLUMNS = {
    "id": "id",
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


# materials 테이블 전체를 가져와서 한글 컬럼명이 붙은 표로 만들어줍니다.
# Supabase는 한 번 요청에 최대 1000건까지만 돌려주므로, 1000건씩 끊어서 끝까지 반복해서 가져옵니다.
# 화면 하나를 그릴 때 이 함수가 여러 탭에서 반복 호출되는데, cache_data로 감싸두면
# 15초 안의 반복 호출은 네트워크를 다시 안 타고 캐시된 결과를 재사용해서 훨씬 빨라집니다.
@st.cache_data(ttl=60)
def load_materials():
    supabase = get_authed_client()
    page_size = 1000
    rows = []
    start = 0
    while True:
        res = supabase.table("materials").select("*").order("id").range(start, start + page_size - 1).execute()
        rows.extend(res.data)
        if len(res.data) < page_size:
            break
        start += page_size
    df = pd.DataFrame(rows, columns=MATERIAL_COLUMNS.keys())
    return df.rename(columns=MATERIAL_COLUMNS)


# history 테이블을 가져오면서, 연결된 자재의 부품명도 같이 붙여서 보여줍니다.
# materials와 마찬가지로 1000건씩 끊어서 끝까지 반복해서 가져옵니다.
@st.cache_data(ttl=60)
def load_history():
    supabase = get_authed_client()
    page_size = 1000
    data = []
    start = 0
    while True:
        res = supabase.table("history").select("*, materials(part_name)").order("id").range(start, start + page_size - 1).execute()
        data.extend(res.data)
        if len(res.data) < page_size:
            break
        start += page_size

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


def delete_history(history_id):
    get_authed_client().table("history").delete().eq("id", history_id).execute()
    load_history.clear()


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


# 입고 처리: 요청 상태를 '입고완료'로 바꾸고, 실제 재고와 입출고 이력에도 반영합니다.
def receive_request(request_id, material_id, received_qty, vendor):
    material = get_material(material_id)
    new_qty = int(material["current_qty"] or 0) + received_qty

    update_material_qty(material_id, new_qty)
    history_id = insert_history({
        "occurred_on": date.today().isoformat(),
        "direction": "입고",
        "material_id": material_id,
        "quantity": received_qty,
        "manager": vendor,
        "note": f"구매요청 #{request_id} 입고 처리",
    })

    get_authed_client().table("purchase_requests").update({
        "status": "입고완료", "received_at": _now(), "received_qty": received_qty, "history_id": history_id,
    }).eq("id", request_id).execute()
    load_purchase_requests.clear()


# 구매요청을 삭제합니다. 이미 입고완료 상태였다면, 그때 반영했던 재고 증가분을
# 되돌리고(원복) 같이 생성됐던 입출고 이력도 함께 지운 뒤 요청을 삭제합니다.
def delete_purchase_request(request_id):
    res = get_authed_client().table("purchase_requests").select("*").eq("id", request_id).execute()
    if not res.data:
        return
    row = res.data[0]

    if row["status"] == "입고완료" and row.get("received_qty"):
        material = get_material(row["material_id"])
        reverted_qty = int(material["current_qty"] or 0) - int(row["received_qty"])
        update_material_qty(row["material_id"], reverted_qty)
        if row.get("history_id"):
            delete_history(row["history_id"])

    get_authed_client().table("purchase_requests").delete().eq("id", request_id).execute()
    load_purchase_requests.clear()
