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

-- 관리자가 아니면 current_qty(현재재고) 외의 필드는 바꿀 수 없도록 막는 트리거입니다.
-- (입출고 등록 시 일반 사용자도 current_qty는 바꿔야 하므로, RLS 정책만으로는 이 구분을 표현할 수 없어 트리거로 처리합니다.)
create or replace function restrict_material_update() returns trigger as $$
begin
    if (auth.jwt() -> 'user_metadata' ->> 'role') <> '관리자' then
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

-- 감사 로그는 로그인한 사람이면 누구나(자재 등록은 일반 계정도 가능하므로) 기록을 남길 수 있지만,
-- 조회(select)는 지정된 한 사람만 볼 수 있도록 관리자보다 더 높은 권한으로 제한합니다.
create policy "superadmin select audit_log" on audit_log
    for select using ((auth.jwt() ->> 'email') = 'gyjeong@hanjin.com');
create policy "authenticated insert audit_log" on audit_log
    for insert with check (auth.role() = 'authenticated');

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
    remarks text
);

alter table boq enable row level security;

create policy "authenticated select boq" on boq
    for select using (auth.role() = 'authenticated');
create policy "admin insert boq" on boq
    for insert with check ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');
create policy "admin update boq" on boq
    for update using ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');

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
    reverted_at timestamptz  -- 원본 구매요청이 나중에 삭제(원복)되면 채워집니다. 기록 자체는 지우지 않고 취소 표시만 남깁니다.
);

alter table purchase_history enable row level security;

create policy "authenticated select purchase_history" on purchase_history
    for select using (auth.role() = 'authenticated');
create policy "admin insert purchase_history" on purchase_history
    for insert with check ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');
create policy "admin update purchase_history" on purchase_history
    for update using ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');
