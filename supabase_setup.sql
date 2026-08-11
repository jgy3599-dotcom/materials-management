-- 자재 마스터 테이블
create table materials (
    id bigint generated always as identity primary key,
    category text,
    part_name text not null,
    install_location text,
    manufacturer text,
    vendor text,
    in_use_qty integer default 0,
    standard_qty integer default 0,
    current_qty integer default 0,
    note text,
    sub_type text,  -- 구분 (예: 롤러/풀리/스프라켓의 "베어링", "키", "풀리" 등 세부 분류)
    warehouse_no text,  -- 창고 번호 (모터/전기/외산(TAMS) 카테고리에서 사용, "44-1"처럼 숫자가 아닌 값도 있어 text)
    order_code text  -- 발주 코드 (외산(TAMS) 카테고리에서 사용)
);

-- 입출고 이력 테이블 (어떤 자재인지는 material_id로 연결)
create table history (
    id bigint generated always as identity primary key,
    occurred_on date not null,
    direction text not null,
    material_id bigint references materials (id),
    quantity integer not null,
    manager text,
    note text,
    equipment_id text,   -- 설비 ID (예: LD451 RK003)
    problem text,        -- 문제/고장 내역
    action_taken text,   -- 조치 내역
    part_memo text        -- 사용 부품 메모
);

-- 로그인한 사용자만 데이터에 접근할 수 있도록 행 단위 보안(RLS)을 켭니다.
alter table materials enable row level security;
alter table history enable row level security;

-- materials: 로그인한 사람이면 조회/등록/수정 가능, 삭제는 관리자만
create policy "authenticated select materials" on materials
    for select using (auth.role() = 'authenticated');
create policy "authenticated insert materials" on materials
    for insert with check (auth.role() = 'authenticated');
create policy "authenticated update materials" on materials
    for update using (auth.role() = 'authenticated');
create policy "admin delete materials" on materials
    for delete using ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');

-- history: 로그인한 사람이면 조회/등록 가능. 수정은 앱에서 직접 쓰진 않지만,
-- 비고 필드를 나눠 담는 것 같은 일괄 정리 작업을 위해 관리자에게는 열어둡니다.
create policy "authenticated select history" on history
    for select using (auth.role() = 'authenticated');
create policy "authenticated insert history" on history
    for insert with check (auth.role() = 'authenticated');
create policy "admin update history" on history
    for update using ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');
create policy "admin delete history" on history
    for delete using ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');

-- 관리자가 아니면 current_qty(현재재고) 외의 필드는 바꿀 수 없도록 막는 트리거입니다.
-- (입출고 등록 시 일반 사용자도 current_qty는 바꿔야 하므로, RLS 정책만으로는 이 구분을 표현할 수 없어 트리거로 처리합니다.)
create or replace function restrict_material_update() returns trigger as $$
begin
    -- ⚠️ coalesce를 빼지 마세요. 권한이 안 적힌 계정은 이 값이 NULL인데, SQL에서
    -- NULL <> '관리자' 의 결과는 거짓이 아니라 NULL이고 IF는 NULL이면 블록을 통째로
    -- 건너뜁니다. 즉 예외가 안 나고 그냥 통과해서, 방어가 있으나 마나가 됩니다.
    -- materials의 UPDATE 정책은 "로그인했으면 허용"이라 이 트리거가 유일한 방어선입니다.
    -- (RLS 정책들은 = '관리자' 형태라 NULL이면 거짓=차단으로 안전하게 닫힙니다.
    --  부등호를 쓰는 여기만 반대로 열립니다.)
    if coalesce(auth.jwt() -> 'user_metadata' ->> 'role', '') <> '관리자' then
        if NEW.category is distinct from OLD.category
            or NEW.part_name is distinct from OLD.part_name
            or NEW.install_location is distinct from OLD.install_location
            or NEW.manufacturer is distinct from OLD.manufacturer
            or NEW.vendor is distinct from OLD.vendor
            or NEW.in_use_qty is distinct from OLD.in_use_qty
            or NEW.standard_qty is distinct from OLD.standard_qty
            or NEW.note is distinct from OLD.note
            or NEW.sub_type is distinct from OLD.sub_type
            or NEW.warehouse_no is distinct from OLD.warehouse_no
            or NEW.order_code is distinct from OLD.order_code
        then
            raise exception '일반 권한은 현재재고만 수정할 수 있습니다.';
        end if;
    end if;
    return NEW;
end;
$$ language plpgsql security definer;

create trigger materials_restrict_update
    before update on materials
    for each row execute function restrict_material_update();

-- 현재재고를 "새 값으로 덮어쓰기"가 아니라 "현재 DB 값에 더하기/빼기"로 한 번에 처리하는 함수입니다.
-- 앱에서 값을 미리 읽어와 계산한 뒤 다시 써넣으면, 그 사이(읽기~쓰기)에 다른 사람이 먼저 바꿔버려서
-- 덮어써지는 경우가 생길 수 있는데(동시 편집 문제), DB가 직접 더하게 하면 이 문제가 안 생깁니다.
-- security definer를 안 붙여서, 호출한 사람 권한 그대로 RLS/트리거 검사를 정상적으로 거칩니다.
create or replace function adjust_material_qty(p_material_id bigint, p_delta integer)
returns void
language plpgsql
as $$
begin
    update materials set current_qty = current_qty + p_delta where id = p_material_id;
end;
$$;

grant execute on function adjust_material_qty(bigint, integer) to authenticated;

-- 관리자가 자재를 수정/삭제할 때마다 남기는 감사 로그입니다.
-- materials.id를 참조(FK)하지 않는 이유: 삭제된 자재의 기록도 그대로 남아있어야 하기 때문입니다.
create table audit_log (
    id bigint generated always as identity primary key,
    occurred_at timestamptz not null default now(),
    actor_email text not null,
    action text not null,
    material_id bigint,
    part_name text,
    before_data jsonb,
    after_data jsonb
);

alter table audit_log enable row level security;

-- 로그인한 사람이 최상위 권한자(현재는 gyjeong@hanjin.com 한 명)인지 확인합니다. 최상위 권한자
-- 이메일이 바뀌거나 늘어날 때 이 함수 한 곳만 고치면 아래 모든 정책에 그대로 반영됩니다.
create or replace function is_superadmin()
returns boolean
language sql
stable
as $$
    select (auth.jwt() ->> 'email') = 'gyjeong@hanjin.com';
$$;

grant execute on function is_superadmin() to authenticated;

-- 감사 로그는 로그인한 사람이면 누구나(자재 등록은 일반 계정도 가능하므로) 기록을 남길 수 있지만,
-- 조회(select)는 지정된 한 사람만 볼 수 있도록 관리자보다 더 높은 권한으로 제한합니다.
-- actor_email은 앱이 보내주는 값을 그대로 믿지 않고, 실제 로그인한 사람의 이메일과 같은지 DB에서 검증합니다
-- (이게 없으면 API를 직접 호출해서 "내가 아닌 다른 사람이 한 것처럼" 로그를 위조할 수 있습니다).
create policy "superadmin select audit_log" on audit_log
    for select using (is_superadmin());
create policy "authenticated insert audit_log" on audit_log
    for insert with check (
        auth.role() = 'authenticated'
        and actor_email = (auth.jwt() ->> 'email')
    );

-- 설비(컨베이어) 설계 사양(BOQ) 테이블입니다. conveyor_id로 검색해서
-- 설비 스펙 + history.equipment_id로 이어지는 사용 이력을 함께 보여주는 용도입니다.
create table boq (
    id bigint generated always as identity primary key,
    conveyor_id text not null unique,
    category_large text,   -- 대분류
    category_mid text,     -- 중분류
    location_1 text,
    location_2 text,
    equipment_type text,   -- 설비구분
    conveyor_type text,
    length_mm numeric,
    width_mm numeric,
    angle numeric,
    belt_type text,
    belt_length text,      -- V벨트 규격 (예: 780Wx13,420)
    motor_model text,
    motor_type text,
    motor_power numeric,
    reducer_ratio text,
    timing_chain text,     -- 타이밍벨트 & 체인
    remarks text,
    conveyor_id_with_plc text  -- 컨베이어 ID에 PLC 그룹 코드까지 붙은 형태 (예: "CC101 LM101 BD001"). 검색용 보조 필드.
);

alter table boq enable row level security;

create policy "authenticated select boq" on boq
    for select using (auth.role() = 'authenticated');
-- BOQ 추가/삭제는 일반 관리자가 아니라 최상위 권한자(is_superadmin() 참고)만 가능합니다.
create policy "superadmin insert boq" on boq
    for insert with check (is_superadmin());
create policy "admin update boq" on boq
    for update using ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');
create policy "superadmin delete boq" on boq
    for delete using (is_superadmin());

-- BOQ를 컨베이어 ID로 검색할 때 띄어쓰기/대소문자를 무시하고 비교합니다.
-- (예: "lm101bd001"이나 "LM101 BD001"이나 다 같은 걸로 찾아짐)
create or replace function find_boq(p_search text)
returns setof boq
language sql
stable
as $$
    select * from boq
    where upper(regexp_replace(conveyor_id, '\s+', '', 'g')) = upper(regexp_replace(p_search, '\s+', '', 'g'))
       or upper(regexp_replace(conveyor_id_with_plc, '\s+', '', 'g')) = upper(regexp_replace(p_search, '\s+', '', 'g'))
    -- conveyor_id_with_plc에는 중복을 막는 제약이 없어서 여러 행이 걸릴 수 있습니다.
    -- 정렬이 없으면 그중 어느 행이 나올지 실행 계획에 따라 달라져, 같은 검색어인데
    -- 다른 스펙이 보이는 일이 생깁니다. 항상 같은 결과가 나오도록 순서를 고정합니다.
    order by id
    limit 1;
$$;

grant execute on function find_boq(text) to authenticated;

-- 구매 요청 워크플로우 테이블입니다.
-- 상태 흐름: 요청됨 -> 검토중 -> 승인됨 -> 구매중 -> 입고완료 (검토중/승인됨 단계에서 반려됨으로 갈 수 있음)
-- 입고완료로 바뀌는 시점에 앱에서 materials.current_qty를 올리고 purchase_history에도 구매 확정 기록을 남깁니다.
create table purchase_requests (
    id bigint generated always as identity primary key,
    material_id bigint not null references materials (id),
    requested_qty integer not null,
    status text not null default '요청됨',
    requester_email text not null,
    request_note text,
    reject_reason text,
    vendor text,
    unit_price numeric,
    received_qty integer,
    requested_at timestamptz not null default now(),
    reviewed_at timestamptz,
    approved_at timestamptz,
    rejected_at timestamptz,
    purchased_at timestamptz,
    received_at timestamptz
);

alter table purchase_requests enable row level security;

-- 로그인한 사람이면 누구나 조회/요청 등록 가능, 상태 전환(수정)은 관리자만
create policy "authenticated select purchase_requests" on purchase_requests
    for select using (auth.role() = 'authenticated');
create policy "authenticated insert purchase_requests" on purchase_requests
    for insert with check (auth.role() = 'authenticated');
create policy "admin update purchase_requests" on purchase_requests
    for update using ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');
create policy "admin delete purchase_requests" on purchase_requests
    for delete using ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');

-- count_open_requests_for_material()에서 이 컬럼으로 자주 필터링하므로 인덱스를 걸어둡니다.
create index idx_purchase_requests_material_id on purchase_requests (material_id);

-- 구매 확정 이력 테이블입니다. 구매요청이 입고완료로 처리되는 순간 한 줄 기록되고,
-- 이후 그 구매요청이 purchase_requests에서 삭제되더라도 이 기록은 지워지지 않고 남습니다.
create table purchase_history (
    id bigint generated always as identity primary key,
    material_id bigint references materials (id),
    quantity integer not null,
    vendor text,
    unit_price numeric,
    received_on date not null,
    request_id bigint references purchase_requests (id) on delete set null,  -- 참고용. 원본 요청이 지워져도 이 이력은 유지됩니다.
    reverted_at timestamptz,  -- 원본 구매요청이 나중에 삭제(원복)되면 채워집니다. 기록 자체는 지우지 않고 취소 표시만 남깁니다.
    item_description text,  -- material_id로 연결 안 되는 레거시 건(자재목록에 없는 소모품 등)의 품명/규격을 텍스트로 남겨둡니다.
    note text  -- 소모품이라 개별 관리 안 함 등 추가 설명.
);

alter table purchase_history enable row level security;

create policy "authenticated select purchase_history" on purchase_history
    for select using (auth.role() = 'authenticated');
create policy "admin insert purchase_history" on purchase_history
    for insert with check ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');
create policy "admin update purchase_history" on purchase_history
    for update using ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');
create policy "admin delete purchase_history" on purchase_history
    for delete using ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');

-- delete_purchase_request()에서 reverted_at을 채울 때 이 컬럼으로 찾으므로 인덱스를 걸어둡니다.
create index idx_purchase_history_request_id on purchase_history (request_id);

-- 수리 건 하나(자재출처가 한진 SPARE/한진 구매품인 사용(출고) 등록 시 자동으로 같이 생깁니다).
-- 재고는 사용(출고) 등록 시점에 이미 정상 차감되므로, 이 테이블 자체는 재고에 영향을 주지 않습니다.
create table repairs (
    id bigint generated always as identity primary key,
    material_id bigint references materials (id),  -- 자재목록에 없는 부품이면 비워두고 item_description을 씁니다.
    quantity integer not null,
    sent_on date not null,
    vendor text,          -- 어디로 보냈는지
    reason text,          -- 수리 사유
    expected_return_date date,
    note text,
    item_description text,  -- material_id가 없을 때, 부품 이름을 텍스트로 남겨둡니다.
    created_at timestamptz not null default now()
);

-- 수리 건 하나가 여러 번에 걸쳐 나눠서 돌아올 수 있어서(예: 1차 4개, 2차 1개), 반납은 별도 테이블로 둡니다.
-- outcome='정상복귀'인 만큼만 현재재고에 다시 더하고, '폐기'는 재고를 복구하지 않습니다.
create table repair_returns (
    id bigint generated always as identity primary key,
    repair_id bigint not null references repairs (id),
    returned_qty integer not null,
    returned_on date not null,
    outcome text not null default '정상복귀',  -- '정상복귀' 또는 '폐기'
    note text
);

alter table repairs enable row level security;
alter table repair_returns enable row level security;

create policy "authenticated select repairs" on repairs
    for select using (auth.role() = 'authenticated');
create policy "authenticated insert repairs" on repairs
    for insert with check (auth.role() = 'authenticated');
create policy "admin update repairs" on repairs
    for update using ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');
create policy "admin delete repairs" on repairs
    for delete using ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');

create policy "authenticated select repair_returns" on repair_returns
    for select using (auth.role() = 'authenticated');
create policy "authenticated insert repair_returns" on repair_returns
    for insert with check (auth.role() = 'authenticated');
create policy "admin update repair_returns" on repair_returns
    for update using ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');
create policy "admin delete repair_returns" on repair_returns
    for delete using ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');

create index idx_repair_returns_repair_id on repair_returns (repair_id);

-- ============================================================================
-- 여러 테이블을 함께 바꾸는 작업을 SQL 함수 하나로 묶습니다.
--
-- 왜 필요한가: 예전에는 앱(파이썬)에서 "재고 바꾸기", "기록 남기기", "상태 바꾸기"를
-- 각각 따로 호출했습니다. 그러면 중간에 네트워크가 끊기거나 오류가 났을 때 앞부분만
-- 반영되고 뒷부분은 안 되는, 서로 어긋난 상태가 남습니다.
-- (예: 재고는 늘었는데 상태는 아직 '구매중' → 다시 입고 처리하면 재고가 두 번 늘어남)
--
-- 함수 안의 문장들은 하나의 트랜잭션으로 처리되어 "전부 성공" 아니면 "전부 취소"가
-- 보장되므로 이런 어긋난 상태가 생기지 않습니다.
--
-- security definer를 일부러 붙이지 않았습니다. 그래야 호출한 사람의 권한 그대로
-- RLS 정책과 트리거 검사를 정상적으로 거칩니다.
-- ============================================================================

-- (1) 사용(출고) 등록: 이력 기록 + (한진 소유 자재면) 재고 차감 + 수리 건 생성.
--     p_deduct_stock은 앱의 MATERIAL_SOURCES 판정 결과입니다(한진 SPARE/한진 구매품만 true).
create or replace function register_usage(
    p_occurred_on date,
    p_material_id bigint,
    p_quantity integer,
    p_manager text,
    p_note text,
    p_equipment_id text,
    p_problem text,
    p_action_taken text,
    p_part_memo text,
    p_deduct_stock boolean
) returns void
language plpgsql
as $$
begin
    -- ⚠️ 화면은 min="1" required로 막지만, 이 RPC는 로그인한 사람 전체에게 열려 있어
    -- 직접 호출할 수 있습니다. 음수를 넣으면 아래 차감이 "현재재고 - (-5)"가 되어
    -- 오히려 재고가 늘고, quantity가 음수인 수리 건까지 만들어져 그 건은 이후 반납
    -- 등록이 영구히 불가능해집니다(add_repair_return의 초과 반납 검사에 늘 걸림).
    if p_quantity <= 0 then
        raise exception '수량은 1개 이상이어야 합니다.';
    end if;

    insert into history (occurred_on, direction, material_id, quantity, manager, note,
                         equipment_id, problem, action_taken, part_memo)
    values (p_occurred_on, '출고', p_material_id, p_quantity, p_manager, p_note,
            p_equipment_id, p_problem, p_action_taken, p_part_memo);

    if p_deduct_stock then
        update materials set current_qty = current_qty - p_quantity where id = p_material_id;

        insert into repairs (material_id, quantity, sent_on, reason, note)
        values (p_material_id, p_quantity, p_occurred_on, p_problem, p_note);
    end if;
end;
$$;

-- (2) 입고 처리: 재고 증가 + 구매이력 기록 + 요청 상태를 '입고완료'로.
--     입고일(p_received_on)은 앱이 쓰던 값을 그대로 받습니다(서버 시간대 차이로 날짜가
--     하루 어긋나는 일이 없도록 DB의 current_date를 쓰지 않습니다).
--     ⚠️ 같은 요청을 두 번 입고하면 재고가 두 배로 들어가고 구매이력도 두 건 생깁니다.
--     화면 새로고침이 실패해 행이 '구매중'으로 남아 관리자가 다시 누르거나, 관리자 두 명이
--     목록을 열어둔 채 동시에 누르면 실제로 벌어집니다. 그래서 DB가 직접 막습니다.
--     pg_advisory_xact_lock으로 같은 요청에 대한 동시 호출을 줄 세운 뒤 상태를 확인합니다.
--     (purchase_requests 행을 select ... for update로 잠그지 않는 이유는 add_repair_return과
--     같습니다 — 테이블을 건드리지 않는 advisory lock이 RLS 정책에 걸리지 않아 안전합니다.)
create or replace function receive_purchase_request(
    p_request_id bigint,
    p_material_id bigint,
    p_received_qty integer,
    p_vendor text,
    p_unit_price numeric,
    p_received_on date
) returns void
language plpgsql
as $$
declare
    v_status text;
    v_material_id bigint;
begin
    perform pg_advisory_xact_lock(4002, p_request_id::int);

    if p_received_qty <= 0 then
        raise exception '입고 수량은 1개 이상이어야 합니다.';
    end if;

    select status, material_id into v_status, v_material_id
      from purchase_requests where id = p_request_id;
    if not found then
        raise exception '구매요청을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다. (id=%)', p_request_id;
    end if;

    -- ⚠️ 재고를 올릴 자재는 "요청 행에 적힌 것"을 씁니다. 호출자가 준 p_material_id를
    -- 그대로 믿으면 안 되는 이유: 삭제(원복)는 remove_purchase_request가 요청 행의
    -- material_id로 되돌리기 때문에, 둘이 다르면 A 자재는 영구히 늘고 B 자재는 영구히
    -- 주는 어긋남이 생기고 되돌릴 방법이 없습니다.
    if p_material_id is distinct from v_material_id then
        raise exception '요청에 적힌 자재와 다른 자재로 입고하려 했습니다. 목록을 새로고침해주세요.';
    end if;

    -- 흔한 실수(두 번 누르기)는 따로 안내합니다.
    if v_status = '입고완료' then
        raise exception '이미 입고 처리된 요청입니다. 재고에는 이미 반영되어 있으니 목록을 새로고침해 확인해주세요.';
    end if;

    -- ⚠️ "막을 상태"를 나열하지 말고 "허용할 상태"만 통과시킵니다. 입고완료만 막으면
    -- 반려됨·요청됨 상태에서도 재고가 늘어납니다. 실제로 벌어지는 경로: 관리자 A가
    -- 구매중 행의 팝업을 열어둔 사이 관리자 B가 반려하면, A의 화면은 읽어둔 목록
    -- 기준이라 입고 버튼이 그대로 보이고 누르면 반려된 건의 재고가 들어갑니다.
    if v_status <> '구매중' then
        raise exception '입고 처리는 구매중인 요청만 할 수 있습니다. 지금 상태는 %입니다. 목록을 새로고침해주세요.', v_status;
    end if;

    update materials set current_qty = current_qty + p_received_qty where id = v_material_id;

    insert into purchase_history (material_id, quantity, vendor, unit_price, received_on, request_id)
    values (v_material_id, p_received_qty, p_vendor, p_unit_price, p_received_on, p_request_id);

    update purchase_requests
       set status = '입고완료', received_at = now(), received_qty = p_received_qty
     where id = p_request_id;
end;
$$;

-- (3) 구매요청 삭제: 이미 입고완료였다면 재고를 원복하고 구매이력에 취소 표시를 남긴 뒤 삭제.
--     purchase_history.request_id는 on delete set null이라 요청을 지우면 연결이 끊어집니다.
--     그래서 reverted_at을 반드시 "삭제 전에" 채워야 어느 이력이 취소된 건지 찾을 수 있습니다.
create or replace function remove_purchase_request(p_request_id bigint)
returns void
language plpgsql
as $$
declare
    v_row purchase_requests;
    v_deleted integer;
begin
    -- ⚠️ receive_purchase_request와 반드시 같은 열쇠(4002)를 써야 합니다. 열쇠가 다르면
    -- 서로를 못 보고 같이 지나갑니다. 그러면 관리자 A가 삭제, B가 입고를 거의 동시에
    -- 눌렀을 때: A가 '구매중' 상태로 읽음 → B의 입고가 끝나 재고가 늘고 이력이 남음 →
    -- A가 요청을 지움. 재고는 늘어난 채로 남는데 요청은 사라지고, 구매이력에는 취소
    -- 표시도 안 찍혀서 나중에 왜 늘었는지 추적할 수 없게 됩니다.
    perform pg_advisory_xact_lock(4002, p_request_id::int);

    select * into v_row from purchase_requests where id = p_request_id;
    if not found then
        return;
    end if;

    if v_row.status = '입고완료' and coalesce(v_row.received_qty, 0) > 0 then
        update materials set current_qty = current_qty - v_row.received_qty
         where id = v_row.material_id;

        update purchase_history set reverted_at = now() where request_id = p_request_id;
    end if;

    delete from purchase_requests where id = p_request_id;

    -- ⚠️ 이 검사를 빼지 마세요. 이 함수는 이 함수를 부른 사람의 권한으로 실행되는데,
    -- UPDATE와 DELETE는 권한 정책에 막히면 오류가 아니라 "0건 처리"로 조용히 넘어갑니다.
    -- 반면 위의 재고 차감은 일반 권한도 통과합니다(현재재고 변경은 허용되므로).
    -- 그래서 검사가 없으면 관리자가 아닌 사람이 이 함수를 직접 불렀을 때
    -- "재고만 깎이고 요청은 그대로 남은 채 성공"이 되고, 반복해서 부르면 재고를
    -- 끝없이 깎을 수 있습니다. 이 RPC는 로그인한 사람 전체에게 열려 있습니다.
    --
    -- 여기서 예외를 던지면 함수 전체가 취소되어 위에서 깎은 재고도 원래대로 돌아갑니다.
    -- 권한 조건을 여기 다시 적지 않고 "삭제가 됐는지"로 판단하는 이유는, 나중에 권한
    -- 정책을 바꿔도 이 함수가 저절로 따라가게 하기 위해서입니다.
    get diagnostics v_deleted = row_count;
    if v_deleted = 0 then
        raise exception '구매요청을 삭제할 권한이 없습니다. 관리자에게 요청해주세요.';
    end if;
end;
$$;

-- (4) 수리 반납 등록: 초과 반납 검증 + 반납 기록 + (정상복귀면) 재고 복구.
--     앱의 입력칸 제한(max_value)은 화면에서만 막는 것이라, 두 사람이 거의 동시에 반납을
--     넣거나 화면이 오래된 값을 들고 있으면 보낸 수량보다 많이 반납되어 재고가 부풀 수 있었습니다.
--     여기서 DB가 직접 검증하므로 그 경로가 막힙니다.
--     pg_advisory_xact_lock은 같은 수리 건에 대한 동시 호출을 줄 세워서, 두 요청이 동시에
--     "아직 여유 있음"으로 판단하고 둘 다 통과하는 것을 막습니다. (repairs 행을 select ... for
--     update로 잠그면 repairs의 UPDATE 정책이 걸려 일반 권한 사용자가 반납을 못 하게 되므로
--     테이블을 건드리지 않는 advisory lock을 씁니다.)
--     material_id가 없는 건(자재목록에 없는 부품)은 되돌려 더할 재고가 없어 기록만 남깁니다.
create or replace function add_repair_return(
    p_repair_id bigint,
    p_returned_qty integer,
    p_returned_on date,
    p_outcome text,
    p_note text
) returns void
language plpgsql
as $$
declare
    v_material_id bigint;
    v_sent_qty integer;
    v_already integer;
begin
    perform pg_advisory_xact_lock(4001, p_repair_id::int);

    if p_returned_qty <= 0 then
        raise exception '반납 수량은 1개 이상이어야 합니다.';
    end if;

    -- ⚠️ 아래에서 재고 복구는 '정상복귀'일 때만 합니다. 그런데 목록의 반납 합계는
    -- 결과와 상관없이 returned_qty를 전부 더하므로, 오타 등으로 둘 중 어느 값도 아닌
    -- 것이 들어오면 "재고는 안 돌아왔는데 화면에는 복귀완료"인 상태가 됩니다.
    -- 조용히 어긋나느니 아예 받지 않습니다.
    if p_outcome not in ('정상복귀', '폐기') then
        raise exception '반납 결과는 정상복귀 또는 폐기만 가능합니다. (받은 값: %)', p_outcome;
    end if;

    select material_id, quantity into v_material_id, v_sent_qty
      from repairs where id = p_repair_id;
    if not found then
        raise exception '수리 건을 찾을 수 없습니다. (id=%)', p_repair_id;
    end if;

    select coalesce(sum(returned_qty), 0) into v_already
      from repair_returns where repair_id = p_repair_id;

    if v_already + p_returned_qty > v_sent_qty then
        raise exception '반납 수량이 보낸 수량을 초과합니다. 보낸 수량 %개, 이미 반납 %개, 이번 요청 %개',
            v_sent_qty, v_already, p_returned_qty;
    end if;

    insert into repair_returns (repair_id, returned_qty, returned_on, outcome, note)
    values (p_repair_id, p_returned_qty, p_returned_on, p_outcome, p_note);

    if p_outcome = '정상복귀' and v_material_id is not null then
        update materials set current_qty = current_qty + p_returned_qty
         where id = v_material_id;
    end if;
end;
$$;

-- ============================================================================
-- 속도 개선용 (2026-07-31 측정 결과에 따라 추가)
-- ============================================================================

-- 화면 맨 위 요약 카드에 쓰는 숫자 3개를 DB에서 한 번에 셉니다.
-- 예전에는 자재 전체(1,200건 이상)를 받아와 파이썬에서 셌는데, 어느 페이지를 열든
-- 매번 그러다 보니 284ms를 먼저 쓰고 시작했습니다. 이 함수로는 80ms 정도면 됩니다.
-- '구매 필요' 판정은 앱과 똑같이 맞춥니다: standard_qty > current_qty.
-- (coalesce를 일부러 안 씁니다. 둘 중 하나가 비어 있으면 비교 결과가 NULL이 되어
--  세지 않는데, 파이썬에서 계산하던 기존 동작과 같습니다.)
create or replace function dashboard_summary()
returns table(total bigint, categories bigint, need_purchase bigint)
language sql
stable
as $$
    select count(*),
           count(distinct category),
           count(*) filter (where standard_qty > current_qty)
    from materials;
$$;

grant execute on function dashboard_summary() to authenticated;

-- BOQ 검색에서 설비 하나의 교체 이력만 뽑을 때 씁니다. 이 인덱스가 없으면 이력 전체를
-- 훑어야 합니다. 예전에는 아예 4,246건을 앱으로 다 받아와서 걸렀는데(550ms),
-- 이제 그 설비 것만 DB에서 바로 가져옵니다(106ms).
create index if not exists idx_history_equipment_id on history (equipment_id);

grant execute on function register_usage(date, bigint, integer, text, text, text, text, text, text, boolean) to authenticated;
grant execute on function receive_purchase_request(bigint, bigint, integer, text, numeric, date) to authenticated;
grant execute on function remove_purchase_request(bigint) to authenticated;
grant execute on function add_repair_return(bigint, integer, date, text, text) to authenticated;
