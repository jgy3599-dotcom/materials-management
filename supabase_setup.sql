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
    note text
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

-- history: 로그인한 사람이면 조회/등록 가능 (수정/삭제는 앱에서 쓰지 않음)
create policy "authenticated select history" on history
    for select using (auth.role() = 'authenticated');
create policy "authenticated insert history" on history
    for insert with check (auth.role() = 'authenticated');

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
