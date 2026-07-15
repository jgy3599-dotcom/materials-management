import streamlit as st
import pandas as pd
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


def get_material(material_id):
    res = get_authed_client().table("materials").select("*").eq("id", material_id).execute()
    return res.data[0] if res.data else None


def update_material(material_id, data):
    get_authed_client().table("materials").update(data).eq("id", material_id).execute()


def delete_material(material_id):
    get_authed_client().table("materials").delete().eq("id", material_id).execute()


def insert_history(data):
    get_authed_client().table("history").insert(data).execute()


def update_material_qty(material_id, new_qty):
    get_authed_client().table("materials").update({"current_qty": new_qty}).eq("id", material_id).execute()


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
    return pd.DataFrame(res.data)
