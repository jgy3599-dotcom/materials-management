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
    note text
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

-- 감사 로그는 관리자가 수정/삭제할 때마다 기록은 남지만(insert), 조회(select)는 지정된
-- 한 사람만 볼 수 있도록 관리자보다 더 높은 권한으로 제한합니다.
create policy "superadmin select audit_log" on audit_log
    for select using ((auth.jwt() ->> 'email') = 'gyjeong@hanjin.com');
create policy "admin insert audit_log" on audit_log
    for insert with check ((auth.jwt() -> 'user_metadata' ->> 'role') = '관리자');
