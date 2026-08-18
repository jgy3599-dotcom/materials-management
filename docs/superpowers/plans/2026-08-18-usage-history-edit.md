# 사용(출고) 이력 수정·삭제 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 사용(출고) 이력 표에서 행을 두 번 클릭하면 팝업이 열려 기록을 고치거나 지울 수 있게 한다. 재고와 수리 건이 함께 정확히 따라간다.

**Architecture:** 재고 조정·수리 건 처리·이력 수정을 DB 함수 하나로 묶어 중간에 끊겨도 어긋나지 않게 한다. `repairs`에 `history_id`를 추가해 "이 출고가 만든 수리 건"을 정확히 찾는다. 화면은 자재 목록의 수정 팝업과 같은 모양을 따른다.

**Tech Stack:** Supabase(PostgreSQL plpgsql RPC), 순수 JavaScript + Tabulator, Playwright(`verify_web.py`), Python(`verify_stage3.py`)

**Spec:** `docs/superpowers/specs/2026-08-18-usage-history-edit-design.md`

## Global Constraints

- **`register_usage`의 이름과 인자를 바꾸지 말 것.** 시그니처가 바뀌면 브라우저에 캐시된 옛 화면을 쓰는 사람이 등록을 못 하게 된다. 안쪽만 고친다.
- **재고 차감 규칙은 `한진 SPARE`와 `한진 구매품`만 차감이다.** 두 번 뒤집혔던 규칙이다(`시스템_규칙과_배경.md` 1절). 화면(`usage.js`의 `MATERIAL_SOURCES`)과 DB(`usage_deducts_stock`) 양쪽에 있으므로 한쪽만 고치지 말 것.
- **권한 검사는 반드시 DB 함수 안에서 한다.** RPC는 로그인한 사람 누구나 직접 부를 수 있어 화면에만 두면 막히지 않는다.
- **재고 음수는 막지 않는다.** 표에 빨갛게 표시하고 알리기만 한다.
- **모든 설명과 주석, 커밋 메시지는 한국어로 쓴다.**
- **SQL은 이 저장소가 자동으로 적용하지 않는다.** `supabase_setup.sql`에 써 넣은 뒤 **사용자가 Supabase 대시보드 SQL 편집기에 붙여넣어 실행**해야 한다.
- **검사 스크립트는 로그인이 필요해 에이전트가 못 돌린다.** 실행이 필요한 단계에서는 사용자에게 명령을 알려주고 결과를 받는다.

## 도우미 이름 맞추기

계획에 나오는 아래 이름들은 **파일을 먼저 읽고 그 저장소의 실제 이름으로 바꿔 쓴다.**
없으면 옆 파일(`materials.js`)에서 같은 일을 하는 것을 가져온다.

| 계획에 쓴 이름 | 확인할 곳 |
|---|---|
| `el(id)` | `materials.js`에 있는 짧은 도우미 |
| `setStatus(id, text, kind)` | 각 페이지가 이미 쓰고 있음 |
| `describeError(err, fallback)` | `purchase.js`·`materials.js`가 씀 |
| `insertAuditLog(...)`의 첫 인자(작성자 메일) | `materials.js`가 넘기는 방식 그대로 |
| `isAdmin` | `materials.js`가 판단하는 방식 그대로 |
| `record(...)`, `admin`, `normal`, `TODAY` | `verify_stage3.py`의 기존 이름 |
| `make_test_material`, `qty_of`, `rejects` | 없으면 기존 검사 코드에서 뽑아 만든다 |

## 파일 구조

| 파일 | 책임 | 변경 |
|---|---|---|
| `supabase_setup.sql` | 스키마·RPC 정의 | 컬럼 1개, 함수 3개 추가, `register_usage` 안쪽 수정 |
| `verify_stage3.py` | DB 업무 규칙 검사 | `[10]` 6개, `[11]` 3개 추가 |
| `web/js/db.js` | DB 호출 모음 | `getUsageHistory` 보강, `getUsage`·`updateUsage`·`deleteUsage` 추가 |
| `web/index.html` | 화면 뼈대 | `usage-dialog` 팝업 추가 |
| `web/js/pages/usage.js` | 사용이력 화면 | 더블클릭 진입, 팝업 열기·미리보기·저장·삭제 |
| `verify_web.py` | 화면 검사 | 사용이력 더블클릭 검사 추가 |

---

### Task 1: `repairs.history_id` 추가와 `register_usage` 연결

출고를 등록할 때 만들어지는 수리 건에 "어느 출고에서 나왔는지"를 남긴다. 이게 없으면 나중에 수정·삭제할 때 엉뚱한 수리 건을 건드린다.

**Files:**
- Modify: `supabase_setup.sql` (`repairs` 정의 부근, `register_usage` 본문)
- Modify: `verify_stage3.py` (기존 `[1]` 검사에 확인 한 줄 추가)

**Interfaces:**
- Consumes: 없음 (첫 작업)
- Produces: `repairs.history_id bigint` 컬럼. 이후 모든 작업이 이 컬럼으로 수리 건을 찾는다.

- [ ] **Step 1: `supabase_setup.sql`의 `repairs` 정의에 컬럼과 인덱스를 추가한다**

`create table repairs (...)` 안에 다음 줄을 넣는다(`item_description` 다음, `created_at` 앞).

```sql
    -- 이 수리 건이 어느 출고에서 생겼는지. register_usage가 채웁니다.
    -- ⚠️ 없으면 나중에 그 출고를 고칠 때 어느 수리 건인지 알 수 없습니다. 자재·수량·날짜로
    --    추측하면 안 됩니다 - 같은 날 같은 자재를 같은 수량으로 두 번 출고한 기록이 있습니다.
    -- 2026-08-18 이전에 만들어진 건은 비어 있습니다(소급이관 168건, 웹앱 등록 2건).
    history_id bigint references history (id) on delete set null,
```

`create table repairs` 블록 바로 아래에 인덱스를 추가한다.

```sql
create index idx_repairs_history_id on repairs (history_id);
```

이미 운영 중인 DB에는 아래를 따로 실행해야 한다. 이 두 줄을 `supabase_setup.sql` 맨 아래 "이미 만든 DB에 적용할 것" 주석과 함께 남긴다.

```sql
alter table repairs add column if not exists history_id bigint references history (id) on delete set null;
create index if not exists idx_repairs_history_id on repairs (history_id);
```

- [ ] **Step 2: `register_usage` 본문에서 이력 번호를 받아 수리 건에 넣는다**

`create or replace function register_usage(...)`의 본문을 아래로 바꾼다. **인자 목록은 손대지 않는다.**

```sql
as $$
declare
    v_history_id bigint;
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
            p_equipment_id, p_problem, p_action_taken, p_part_memo)
    returning id into v_history_id;

    if p_deduct_stock then
        update materials set current_qty = current_qty - p_quantity where id = p_material_id;

        -- history_id를 같이 넣어야 나중에 이 출고를 고치거나 지울 때 이 수리 건을 찾습니다.
        insert into repairs (material_id, quantity, sent_on, reason, note, history_id)
        values (p_material_id, p_quantity, p_occurred_on, p_problem, p_note, v_history_id);
    end if;
end;
$$;
```

- [ ] **Step 3: 사용자에게 SQL 적용을 요청한다**

Supabase 대시보드 → SQL Editor에 Step 1의 `alter table` 두 줄과 Step 2의 `create or replace function register_usage` 전체를 붙여넣어 실행해 달라고 요청한다. 오류가 나면 그 내용을 받아 고친다.

- [ ] **Step 4: `verify_stage3.py`의 `[1]` 검사에 확인을 한 줄 더한다**

`[1]` 출고 등록 검사에서 수리 건이 생겼는지 보는 부분을 찾아, 그 수리 건의 `history_id`가 방금 만든 이력을 가리키는지도 본다.

```python
    # [1-2] 수리 건이 출고 이력과 이어져 있는가
    # 이게 비어 있으면 나중에 그 출고를 고칠 때 어느 수리 건인지 찾을 수 없습니다.
    rep = admin.table("repairs").select("id,history_id").eq(
        "material_id", created["material_id"]).order("id", desc=True).limit(1).execute().data
    hist = admin.table("history").select("id").eq(
        "material_id", created["material_id"]).eq("direction", "출고").order(
        "id", desc=True).limit(1).execute().data
    record("[1-2] 수리 건에 출고 이력 번호가 들어간다",
           bool(rep) and bool(hist) and rep[0]["history_id"] == hist[0]["id"],
           f"repairs.history_id={rep[0]['history_id'] if rep else None} / history.id={hist[0]['id'] if hist else None}")
```

> 실제 변수명(`admin`, `created`, `record`)은 `verify_stage3.py`의 기존 코드에 맞춘다. 파일을 먼저 읽고 그 이름을 그대로 쓸 것.

- [ ] **Step 5: 사용자에게 검사 실행을 요청하고 결과를 받는다**

```
python verify_stage3.py
```

기대: 기존 검사가 전부 그대로 통과하고 `[1-2]`가 새로 통과한다. **기존 검사 중 하나라도 깨지면 멈추고 원인을 찾는다** — `register_usage`는 매일 쓰이는 함수다.

- [ ] **Step 6: 커밋**

```bash
git add supabase_setup.sql verify_stage3.py
git commit -m "수리 건에 출고 이력 번호 남기기 - repairs.history_id

출고를 고치거나 지울 때 '이 출고가 만든 수리 건'을 정확히 찾기 위해서다.
지금은 연결 고리가 없어서 자재·수량·날짜로 추측해야 하는데, 같은 날 같은
자재를 같은 수량으로 두 번 출고한 기록이 실제로 있어(2026-06-22 Tail DRUM
2건) 엉뚱한 수리 건을 지우게 된다.

register_usage 의 이름과 인자는 그대로 두고 안쪽만 고쳤다. 시그니처가 바뀌면
브라우저에 캐시된 옛 화면을 쓰는 사람이 등록을 못 하게 된다.

기존 건 170건은 비어 있게 둔다. 소급이관한 대여반납 168건과 웹앱 등록 2건뿐이고,
history 4,457건은 대부분 직접 넣은 것이라 수리 건이 아예 없다."
```

---

### Task 2: `usage_deducts_stock` 함수

"한진 자재만 재고를 깎는다"는 규칙을 DB도 알아야 한다. 이력을 고칠 때 **예전 출처가 깎였는지**를 판단해야 하기 때문이다.

**Files:**
- Modify: `supabase_setup.sql` (`register_usage` 앞)
- Modify: `web/js/pages/usage.js:14-20` (주석만 추가)

**Interfaces:**
- Consumes: 없음
- Produces: `usage_deducts_stock(p_manager text) returns boolean`. Task 3·4가 쓴다.

- [ ] **Step 1: 함수를 추가한다**

`supabase_setup.sql`의 `register_usage` 정의 바로 앞에 넣는다.

```sql
-- 이 자재 출처가 현재재고를 깎는 대상인지 판단합니다.
--
-- ⚠️ 같은 규칙이 화면에도 있습니다 - web/js/pages/usage.js 의 MATERIAL_SOURCES.
--    한쪽만 고치면 등록과 수정이 서로 다르게 동작해 재고가 조용히 어긋납니다.
--    이 규칙은 두 번 뒤집혔던 이력이 있습니다(시스템_규칙과_배경.md 1절).
--    바꾸려면 그 기록을 먼저 볼 것.
create or replace function usage_deducts_stock(p_manager text)
returns boolean
language sql
immutable
as $$
    select p_manager in ('한진 SPARE', '한진 구매품');
$$;

grant execute on function usage_deducts_stock(text) to authenticated;
```

- [ ] **Step 2: 화면 쪽에도 서로를 가리키는 주석을 단다**

`web/js/pages/usage.js`의 `MATERIAL_SOURCES` 위에 넣는다.

```javascript
// 자재 출처별로 현재재고를 깎는지 여부입니다.
//
// ⚠️ 같은 규칙이 DB에도 있습니다 - supabase_setup.sql 의 usage_deducts_stock().
//    출고 등록은 이 값을 보고, 출고 수정은 DB 함수를 봅니다. 한쪽만 고치면
//    등록과 수정이 서로 다르게 동작해 재고가 조용히 어긋납니다.
//    이 규칙은 두 번 뒤집혔던 이력이 있습니다(시스템_규칙과_배경.md 1절).
const MATERIAL_SOURCES = {
```

- [ ] **Step 3: 사용자에게 SQL 적용을 요청한다**

Step 1의 SQL을 Supabase SQL Editor에서 실행해 달라고 요청한다.

- [ ] **Step 4: 값이 맞는지 확인한다**

사용자에게 Supabase SQL Editor에서 아래를 실행해 결과를 알려달라고 요청한다.

```sql
select usage_deducts_stock('한진 SPARE')   as spare,      -- 기대 true
       usage_deducts_stock('한진 구매품')  as bought,     -- 기대 true
       usage_deducts_stock('보우')         as bow,        -- 기대 false
       usage_deducts_stock('POSCO')        as posco,      -- 기대 false
       usage_deducts_stock('BEUMER')       as beumer,     -- 기대 false
       usage_deducts_stock(null)           as null_case;  -- 기대 null
```

`null_case`가 `null`인 것은 문제없다. 아래 함수들에서 `if usage_deducts_stock(...) then` 은 `null`을 거짓으로 다룬다.

- [ ] **Step 5: 커밋**

```bash
git add supabase_setup.sql web/js/pages/usage.js
git commit -m "재고 차감 규칙을 DB에도 둔다 - usage_deducts_stock

이력을 고칠 때 '예전 출처가 재고를 깎았는지'를 DB가 스스로 알아야 한다.
지금은 이 규칙이 화면(usage.js MATERIAL_SOURCES)에만 있다.

규칙이 두 군데 생기므로 양쪽 주석에 서로를 가리키는 경고를 달았다.
두 번 뒤집혔던 규칙이라 특히 조심할 부분이다."
```

---

### Task 3: `update_usage` 함수와 검사 [10]

**Files:**
- Modify: `verify_stage3.py` (검사 `[10]` 추가)
- Modify: `supabase_setup.sql` (함수 추가)

**Interfaces:**
- Consumes: `usage_deducts_stock(text)`, `repairs.history_id`
- Produces: `update_usage(p_id bigint, p_occurred_on date, p_material_id bigint, p_quantity integer, p_manager text, p_note text, p_equipment_id text, p_problem text, p_action_taken text, p_part_memo text) returns void`

- [ ] **Step 1: 검사 [10]을 먼저 쓴다**

`verify_stage3.py`의 `[9]` 다음에 넣는다. 기존 검사와 같이 **임시 자재로만 시험하고 끝나면 지운다.** 변수명은 파일의 기존 것에 맞춘다.

```python
    # ---------------------------------------------------------------- [10] 출고 수정
    print("\n[10] 출고 수정")

    # 임시 자재 두 개(A, B)를 만들어 자재 갈아타기까지 시험합니다.
    mat_a = make_test_material(admin, "__검증용_출고수정A__", start_qty=10)
    mat_b = make_test_material(admin, "__검증용_출고수정B__", start_qty=10)

    # 한진 구매품으로 1개 출고 -> A는 9가 되고 수리 건이 하나 생깁니다.
    admin.rpc("register_usage", {
        "p_occurred_on": TODAY, "p_material_id": mat_a, "p_quantity": 1,
        "p_manager": "한진 구매품", "p_note": "검증", "p_equipment_id": "TEST-EQ",
        "p_problem": "검증", "p_action_taken": "검증", "p_part_memo": "검증",
        "p_deduct_stock": True,
    }).execute()
    hid = admin.table("history").select("id").eq("material_id", mat_a).eq(
        "direction", "출고").order("id", desc=True).limit(1).execute().data[0]["id"]

    def edit(**over):
        args = {"p_id": hid, "p_occurred_on": TODAY, "p_material_id": mat_a,
                "p_quantity": 1, "p_manager": "한진 구매품", "p_note": "검증",
                "p_equipment_id": "TEST-EQ", "p_problem": "검증",
                "p_action_taken": "검증", "p_part_memo": "검증"}
        args.update(over)
        return admin.rpc("update_usage", args).execute()

    # [10-1] 수량 1 -> 3 이면 재고가 2 더 줄어야 합니다 (9 -> 7)
    edit(p_quantity=3)
    record("[10-1] 수량을 바꾸면 재고가 차이만큼 반영된다",
           qty_of(admin, mat_a) == 7, f"현재재고={qty_of(admin, mat_a)}")

    # [10-2] 출처를 보우로 바꾸면 재고가 원복되고(7 -> 10) 수리 건이 사라져야 합니다
    edit(p_quantity=3, p_manager="보우")
    reps = admin.table("repairs").select("id").eq("history_id", hid).execute().data
    record("[10-2] 한진에서 보우로 바꾸면 재고 원복 + 수리 건 삭제",
           qty_of(admin, mat_a) == 10 and not reps,
           f"현재재고={qty_of(admin, mat_a)} / 수리건={len(reps)}")

    # [10-3] 다시 한진으로 되돌린 뒤(10 -> 9) 자재를 B로 바꾸면 A는 10, B는 9
    edit(p_quantity=1, p_manager="한진 구매품")
    edit(p_quantity=1, p_manager="한진 구매품", p_material_id=mat_b)
    record("[10-3] 자재를 바꾸면 옛 자재는 늘고 새 자재는 준다",
           qty_of(admin, mat_a) == 10 and qty_of(admin, mat_b) == 9,
           f"A={qty_of(admin, mat_a)} / B={qty_of(admin, mat_b)}")

    # [10-5] 수량 0 은 거부되어야 합니다
    record("[10-5] 수량 0은 거부된다", rejects(lambda: edit(p_quantity=0, p_material_id=mat_b)))

    # [10-4] 반납이 등록된 건은 수정이 거부되어야 합니다
    # 지금 B에 딸린 수리 건이 있으므로 거기에 반납을 넣고 다시 고쳐 봅니다.
    rep_id = admin.table("repairs").select("id").eq(
        "history_id", hid).execute().data[0]["id"]
    admin.rpc("add_repair_return", {
        "p_repair_id": rep_id, "p_returned_qty": 1, "p_returned_on": TODAY,
        "p_outcome": "정상복귀", "p_note": "검증",
    }).execute()
    record("[10-4] 반납이 등록된 건은 수정이 거부된다",
           rejects(lambda: edit(p_quantity=2, p_material_id=mat_b)))

    # [10-6] 일반 권한으로는 수정이 막혀야 합니다 (일반 계정을 건너뛰면 실패로 기록)
    if normal is None:
        record("[10-6] 일반 권한으로는 수정이 막힌다", False, "일반 계정 로그인을 건너뜀")
    else:
        record("[10-6] 일반 권한으로는 수정이 막힌다",
               rejects(lambda: normal.rpc("update_usage", {
                   "p_id": hid, "p_occurred_on": TODAY, "p_material_id": mat_b,
                   "p_quantity": 1, "p_manager": "한진 구매품", "p_note": "검증",
                   "p_equipment_id": "TEST-EQ", "p_problem": "검증",
                   "p_action_taken": "검증", "p_part_memo": "검증",
               }).execute()))
```

`make_test_material`, `qty_of`, `rejects`가 파일에 없으면 기존 코드에서 같은 일을 하는 부분을 함수로 뽑아 만든다. `rejects(fn)`은 `fn()`이 예외를 내면 `True`를 돌려준다.

- [ ] **Step 2: 사용자에게 검사를 돌려 실패를 확인받는다**

```
python verify_stage3.py
```

기대: `[10]`의 여섯 개가 전부 실패한다. 이유는 `update_usage` 함수가 아직 없기 때문이다. **다른 이유로 실패하면 검사 코드 자체가 잘못된 것이니 먼저 고친다.**

- [ ] **Step 3: 함수를 구현한다**

`supabase_setup.sql`의 `register_usage` 다음에 넣는다.

```sql
-- 출고 이력을 고칩니다. 재고 조정·수리 건 처리·이력 수정이 한 묶음으로 일어납니다.
--
-- 화면에서 나눠 부르면 중간에 통신이 끊겼을 때 재고만 바뀌고 이력은 그대로인 상태가
-- 생깁니다. 그래서 함수 하나로 묶습니다.
--
-- ⚠️ 수리 건은 원래 있던 것만 따라갑니다. 없던 것을 새로 만들지 않습니다.
--    2026-07 이관분 4,244건과 2026-08-18에 넣은 211건은 한진 출처인데 수리 건이
--    없습니다(history에 직접 넣었기 때문). 오타 하나 고쳤다고 수리 목록에 수천 건이
--    갑자기 나타나면 안 됩니다.
create or replace function update_usage(
    p_id bigint,
    p_occurred_on date,
    p_material_id bigint,
    p_quantity integer,
    p_manager text,
    p_note text,
    p_equipment_id text,
    p_problem text,
    p_action_taken text,
    p_part_memo text
) returns void
language plpgsql
as $$
declare
    v_old history%rowtype;
    v_repair_id bigint;
begin
    if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from '관리자' then
        raise exception '관리자만 출고 이력을 고칠 수 있습니다.';
    end if;

    if p_quantity <= 0 then
        raise exception '수량은 1개 이상이어야 합니다.';
    end if;

    -- ⚠️ for update 로 잠급니다. 관리자 둘이 같은 행을 동시에 고치면 둘 다 "옛 수량 1"을
    --    읽고 각자 재고를 +1 되돌려 2가 늘어납니다.
    select * into v_old from history where id = p_id and direction = '출고' for update;
    if not found then
        raise exception '출고 이력을 찾을 수 없습니다.';
    end if;

    select id into v_repair_id from repairs where history_id = p_id;

    if v_repair_id is not null
       and exists (select 1 from repair_returns where repair_id = v_repair_id) then
        raise exception '수리 반납이 등록되어 있어 고칠 수 없습니다. 반납을 먼저 취소하세요.';
    end if;

    -- 옛 상태 되돌리기. material_id가 비어 있으면 0행에 걸려 아무 일도 안 일어납니다.
    if usage_deducts_stock(v_old.manager) and v_old.material_id is not null then
        update materials set current_qty = current_qty + v_old.quantity
        where id = v_old.material_id;
    end if;

    -- 수리 건 처리 (없으면 새로 만들지 않습니다)
    if v_repair_id is not null then
        if usage_deducts_stock(p_manager) then
            update repairs
               set material_id = p_material_id, quantity = p_quantity,
                   sent_on = p_occurred_on, reason = p_problem, note = p_note
             where id = v_repair_id;
        else
            delete from repairs where id = v_repair_id;
        end if;
    end if;

    -- 새 상태 적용
    if usage_deducts_stock(p_manager) and p_material_id is not null then
        update materials set current_qty = current_qty - p_quantity
        where id = p_material_id;
    end if;

    update history
       set occurred_on = p_occurred_on, material_id = p_material_id,
           quantity = p_quantity, manager = p_manager, note = p_note,
           equipment_id = p_equipment_id, problem = p_problem,
           action_taken = p_action_taken, part_memo = p_part_memo
     where id = p_id;
end;
$$;

grant execute on function update_usage(bigint, date, bigint, integer, text, text,
                                       text, text, text, text) to authenticated;
```

- [ ] **Step 4: 사용자에게 SQL 적용과 검사 재실행을 요청한다**

Step 3의 SQL을 Supabase SQL Editor에서 실행한 뒤 `python verify_stage3.py`.

기대: `[10]` 여섯 개가 전부 통과하고 기존 검사도 그대로 통과한다.

- [ ] **Step 5: 커밋**

```bash
git add supabase_setup.sql verify_stage3.py
git commit -m "출고 이력 수정 - update_usage

재고 조정·수리 건 처리·이력 수정을 함수 하나로 묶었다. 화면에서 나눠 부르면
중간에 끊겼을 때 재고만 바뀌고 이력은 그대로인 상태가 생긴다.

수리 건은 원래 있던 것만 따라간다. 없던 것을 새로 만들지 않는다. 2026-07
이관분 4,244건은 한진 출처인데 수리 건이 없어서, 오타 하나 고쳤다고 수리
목록에 수천 건이 나타나면 안 된다.

for update 로 행을 잠근다. 관리자 둘이 동시에 고치면 둘 다 옛 수량을 읽고
각자 재고를 되돌려 두 배로 늘어난다.

검사 [10] 여섯 개 추가. 그중 [10-6]은 일반 계정 로그인을 건너뛰면 검사되지
않는다 - 관리자로만 돌리면 권한 검사가 통째로 사라져도 통과한다."
```

---

### Task 4: `delete_usage` 함수와 검사 [11]

**Files:**
- Modify: `verify_stage3.py` (검사 `[11]` 추가)
- Modify: `supabase_setup.sql` (함수 추가)

**Interfaces:**
- Consumes: `usage_deducts_stock(text)`, `repairs.history_id`
- Produces: `delete_usage(p_id bigint) returns void`

- [ ] **Step 1: 검사 [11]을 먼저 쓴다**

`[10]` 다음에 넣는다.

```python
    # ---------------------------------------------------------------- [11] 출고 삭제
    print("\n[11] 출고 삭제")

    mat_c = make_test_material(admin, "__검증용_출고삭제C__", start_qty=10)
    admin.rpc("register_usage", {
        "p_occurred_on": TODAY, "p_material_id": mat_c, "p_quantity": 2,
        "p_manager": "한진 SPARE", "p_note": "검증", "p_equipment_id": "TEST-EQ",
        "p_problem": "검증", "p_action_taken": "검증", "p_part_memo": "검증",
        "p_deduct_stock": True,
    }).execute()
    del_hid = admin.table("history").select("id").eq("material_id", mat_c).eq(
        "direction", "출고").order("id", desc=True).limit(1).execute().data[0]["id"]

    # [11-3] 일반 권한으로는 삭제가 막혀야 합니다 (먼저 시험해야 대상이 남아 있습니다)
    if normal is None:
        record("[11-3] 일반 권한으로는 삭제가 막힌다", False, "일반 계정 로그인을 건너뜀")
    else:
        record("[11-3] 일반 권한으로는 삭제가 막힌다",
               rejects(lambda: normal.rpc("delete_usage", {"p_id": del_hid}).execute()))

    # [11-2] 반납이 등록된 건은 삭제가 거부되어야 합니다
    del_rep = admin.table("repairs").select("id").eq(
        "history_id", del_hid).execute().data[0]["id"]
    admin.rpc("add_repair_return", {
        "p_repair_id": del_rep, "p_returned_qty": 1, "p_returned_on": TODAY,
        "p_outcome": "정상복귀", "p_note": "검증",
    }).execute()
    record("[11-2] 반납이 등록된 건은 삭제가 거부된다",
           rejects(lambda: admin.rpc("delete_usage", {"p_id": del_hid}).execute()))

    # [11-1] 반납을 지우고 나면 삭제가 되고, 재고 원복 + 수리 건 삭제 + 이력 삭제가 함께
    admin.table("repair_returns").delete().eq("repair_id", del_rep).execute()
    admin.rpc("delete_usage", {"p_id": del_hid}).execute()
    left_hist = admin.table("history").select("id").eq("id", del_hid).execute().data
    left_rep = admin.table("repairs").select("id").eq("history_id", del_hid).execute().data
    record("[11-1] 삭제하면 재고 원복 + 수리 건 삭제 + 이력 삭제가 한 번에",
           qty_of(admin, mat_c) == 10 and not left_hist and not left_rep,
           f"현재재고={qty_of(admin, mat_c)} / 이력={len(left_hist)} / 수리건={len(left_rep)}")
```

뒷정리에서 `mat_a`, `mat_b`, `mat_c`와 거기 딸린 이력·수리 건을 지우도록 기존 정리 코드에 추가한다.

- [ ] **Step 2: 사용자에게 검사를 돌려 실패를 확인받는다**

```
python verify_stage3.py
```

기대: `[11]` 세 개가 `delete_usage` 없음으로 실패한다.

- [ ] **Step 3: 함수를 구현한다**

```sql
-- 출고 이력을 지웁니다. 재고 원복·수리 건 삭제·이력 삭제가 한 묶음으로 일어납니다.
create or replace function delete_usage(p_id bigint)
returns void
language plpgsql
as $$
declare
    v_old history%rowtype;
    v_repair_id bigint;
begin
    if (auth.jwt() -> 'app_metadata' ->> 'role') is distinct from '관리자' then
        raise exception '관리자만 출고 이력을 지울 수 있습니다.';
    end if;

    select * into v_old from history where id = p_id and direction = '출고' for update;
    if not found then
        raise exception '출고 이력을 찾을 수 없습니다.';
    end if;

    select id into v_repair_id from repairs where history_id = p_id;

    if v_repair_id is not null
       and exists (select 1 from repair_returns where repair_id = v_repair_id) then
        raise exception '수리 반납이 등록되어 있어 지울 수 없습니다. 반납을 먼저 취소하세요.';
    end if;

    if usage_deducts_stock(v_old.manager) and v_old.material_id is not null then
        update materials set current_qty = current_qty + v_old.quantity
        where id = v_old.material_id;
    end if;

    if v_repair_id is not null then
        delete from repairs where id = v_repair_id;
    end if;

    delete from history where id = p_id;
end;
$$;

grant execute on function delete_usage(bigint) to authenticated;
```

- [ ] **Step 4: 사용자에게 SQL 적용과 검사 재실행을 요청한다**

기대: `[10]`과 `[11]` 전부 통과, 기존 검사도 그대로 통과.

- [ ] **Step 5: 커밋**

```bash
git add supabase_setup.sql verify_stage3.py
git commit -m "출고 이력 삭제 - delete_usage

재고 원복·수리 건 삭제·이력 삭제를 함수 하나로 묶었다. 반납이 등록된 건은
거부한다 - 재고가 여러 번 오가며 꼬이는 것을 막는다.

검사 [11] 세 개 추가. [11-3]은 일반 계정 로그인을 건너뛰면 검사되지 않는다."
```

---

### Task 5: `db.js`에 조회·수정·삭제 함수 추가

**Files:**
- Modify: `web/js/db.js` (`getUsageHistory` 보강, 함수 3개 추가)

**Interfaces:**
- Consumes: `update_usage`, `delete_usage` RPC
- Produces: `getUsage(id)`, `updateUsage(id, values)`, `deleteUsage(id)`. Task 6·7이 쓴다.

- [ ] **Step 1: `getUsageHistory`가 행 번호를 돌려주게 한다**

지금은 `id`를 안 돌려줘서 어느 행을 고칠지 알 수 없다.

```javascript
    return rows.map((row) => ({
        id: row.id,
        material_id: row.material_id,
        일자: row.occurred_on,
        ...historyPartName(row),
        수량: row.quantity,
        "자재 출처": row.manager,
        설비ID: row.equipment_id,
        문제: row.problem,
        조치: row.action_taken,
        비고: row.note,
    }));
```

`select`에 `id`와 `material_id`가 없으면 함께 추가한다. `usage.js`의 `COLUMNS`에는 넣지 않으므로 화면에는 안 보인다.

- [ ] **Step 2: 한 건을 다시 읽는 함수를 추가한다**

팝업을 열 때 최신 값과 **반납 여부**를 함께 읽는다. `repairs.history_id`가 생겼으므로 한 번에 가져올 수 있다.

```javascript
// 출고 이력 한 건을 다시 읽습니다. 팝업을 열 때 씁니다.
// 딸린 수리 건과 그 반납까지 같이 가져와, 반납이 있으면 화면에서 수정을 잠급니다.
export async function getUsage(id) {
    const { data, error } = await supabase
        .from("history")
        .select("*, materials(part_name), repairs(id, repair_returns(id))")
        .eq("id", id)
        .maybeSingle();
    if (error) throw error;
    if (!data) return null;

    const returned = (data.repairs ?? []).some((r) => (r.repair_returns ?? []).length > 0);
    return {
        id: data.id,
        occurred_on: data.occurred_on,
        material_id: data.material_id,
        part_name: data.materials?.part_name ?? null,
        quantity: data.quantity,
        manager: data.manager,
        equipment_id: data.equipment_id,
        problem: data.problem,
        action_taken: data.action_taken,
        part_memo: data.part_memo,
        note: data.note,
        hasRepairReturn: returned,
    };
}
```

- [ ] **Step 3: 수정·삭제 호출 함수를 추가한다**

```javascript
// 출고 이력을 고칩니다. 재고와 수리 건은 DB 함수가 함께 처리합니다.
export async function updateUsage(id, v) {
    const { error } = await supabase.rpc("update_usage", {
        p_id: id,
        p_occurred_on: v.occurred_on,
        p_material_id: v.material_id,
        p_quantity: v.quantity,
        p_manager: v.manager,
        p_note: v.note,
        p_equipment_id: v.equipment_id,
        p_problem: v.problem,
        p_action_taken: v.action_taken,
        p_part_memo: v.part_memo,
    });
    if (error) throw error;
}


// 출고 이력을 지웁니다. 재고 원복과 수리 건 삭제도 DB 함수가 함께 합니다.
export async function deleteUsage(id) {
    const { error } = await supabase.rpc("delete_usage", { p_id: id });
    if (error) throw error;
}
```

- [ ] **Step 4: 문법을 확인한다**

```
node --check web/js/db.js
```

기대: 오류 없음.

- [ ] **Step 5: 사용자에게 화면 회귀 확인을 요청한다**

`git push` 후 배포를 기다렸다가:

```
python verify_web.py
```

기대: 30개 항목 전체 통과. `getUsageHistory`에 칸을 더했을 뿐이라 화면은 그대로여야 한다.

- [ ] **Step 6: 커밋**

```bash
git add web/js/db.js
git commit -m "출고 이력 조회·수정·삭제 함수 추가

getUsageHistory 가 행 번호를 안 돌려줘서 어느 행을 고칠지 알 수 없었다.
id 와 material_id 를 추가했다. COLUMNS 에 안 넣었으므로 화면에는 안 보인다.

getUsage 는 팝업을 열 때 쓴다. repairs.history_id 가 생겨서 딸린 수리 건과
반납 여부까지 한 번에 가져올 수 있다."
```

---

### Task 6: 팝업 뼈대와 열기

**Files:**
- Modify: `web/index.html` (`usage-dialog` 추가)
- Modify: `web/js/pages/usage.js` (더블클릭 진입, `openDialog`)

**Interfaces:**
- Consumes: `getUsage(id)`, `fillPartOptions`, `fillSourceOptions`
- Produces: `openDialog(id)`. Task 7이 저장·삭제를 붙인다.

- [ ] **Step 1: `index.html`에 팝업을 추가한다**

`mat-dialog` 바로 다음에 같은 모양으로 넣는다. 클래스와 버튼 배치는 `mat-dialog`를 그대로 따른다.

```html
<dialog id="usage-dialog" class="dialog-wide">
    <h3>출고 이력 수정</h3>
    <div class="form-grid">
        <label>일자<input type="date" id="ud-date"></label>
        <label>카테고리로 좁히기<select id="ud-category"></select></label>
        <label>부품명(규격)<select id="ud-part"></select></label>
        <label>자재 출처<select id="ud-source"></select></label>
        <label>수량<input type="number" id="ud-qty" min="1"></label>
        <label>설비ID<input type="text" id="ud-equipment"></label>
        <label>문제<input type="text" id="ud-problem"></label>
        <label>조치<input type="text" id="ud-action"></label>
        <label>부품메모<input type="text" id="ud-part-memo"></label>
        <label>비고<input type="text" id="ud-note"></label>
    </div>
    <p id="ud-stock-hint" class="hint"></p>
    <p id="ud-dialog-status" class="status"></p>
    <div class="dialog-actions">
        <button id="ud-save-btn" disabled>저장</button>
        <label><input type="checkbox" id="ud-delete-confirm" disabled> 확인했습니다</label>
        <button id="ud-delete-btn" disabled class="danger">삭제</button>
        <button id="ud-close-btn" type="button">닫기</button>
    </div>
</dialog>
```

- [ ] **Step 2: 표에 더블클릭을 붙인다**

`usage.js`의 `renderTable` 호출에 한 줄 더한다. **기존 `onRowClick`은 그대로 둔다** — 한 번 클릭은 BOQ 이동이다.

```javascript
        renderTable(TABLE_ID, history, COLUMNS, {
            selectable: true,
            onRowClick: (row) => {
                const id = row["설비ID"];
                document.getElementById("usage-jump").classList.toggle("hidden", !id);
                document.getElementById("usage-jump-btn").textContent = `🔎 '${id}' BOQ 검색으로 이동`;
                document.getElementById("usage-jump-btn").dataset.equipmentId = id ?? "";
            },
            onRowDblClick: isAdmin ? (row) => openDialog(row.id) : null,
        });
```

`isAdmin`이 이 파일에 없으면 `materials.js`가 쓰는 것과 같은 방식으로 가져온다.

- [ ] **Step 3: `openDialog`를 쓴다**

`materials.js`의 `openDialog`와 같은 순서다. **다 채운 뒤에야 버튼을 푼다** — 불러오기가 실패한 창에서 저장·삭제가 눌리지 않게.

```javascript
let openUsage = null;   // 지금 팝업에 열려 있는 출고 이력

async function openDialog(id) {
    openUsage = null;
    resetUsageDialog();
    setStatus("ud-dialog-status", "불러오는 중...");
    document.getElementById("usage-dialog").showModal();

    let fresh;
    try {
        fresh = await getUsage(id);
    } catch (err) {
        setStatus("ud-dialog-status",
            describeError(err, "출고 이력을 불러오지 못했습니다."), "error");
        return;
    }
    if (!fresh) {
        setStatus("ud-dialog-status",
            "이 기록을 찾을 수 없습니다. 이미 삭제되었을 수 있습니다.", "error");
        return;
    }

    fillDialogPartOptions();
    fillDialogSourceOptions();
    el("ud-date").value = fresh.occurred_on ?? "";
    el("ud-part").value = fresh.material_id ?? "";
    el("ud-source").value = fresh.manager ?? "";
    el("ud-qty").value = fresh.quantity ?? 1;
    el("ud-equipment").value = fresh.equipment_id ?? "";
    el("ud-problem").value = fresh.problem ?? "";
    el("ud-action").value = fresh.action_taken ?? "";
    el("ud-part-memo").value = fresh.part_memo ?? "";
    el("ud-note").value = fresh.note ?? "";

    // 반납이 등록된 건은 손댈 수 없습니다. 재고가 여러 번 오가며 꼬이는 것을 막습니다.
    if (fresh.hasRepairReturn) {
        setStatus("ud-dialog-status",
            "이 출고는 수리 반납이 등록되어 있어 고칠 수 없습니다. "
            + "수리 관리에서 반납을 먼저 취소하세요.", "error");
        openUsage = fresh;
        return;   // 버튼을 잠근 채로 둡니다
    }

    // 2026-07 이관분은 자재가 연결돼 있지 않습니다. 자재를 지정하면 그때부터 재고가 빠집니다.
    if (fresh.material_id == null) {
        setStatus("ud-dialog-status",
            "이 기록은 자재가 연결돼 있지 않습니다. 자재를 지정하면 그 자재의 "
            + "재고에서 빠집니다. 비워 두면 재고는 그대로입니다.");
    }

    el("ud-save-btn").disabled = false;
    el("ud-delete-confirm").disabled = false;
    openUsage = fresh;
}
```

`resetUsageDialog`, `fillDialogPartOptions`, `fillDialogSourceOptions`는 등록 폼의 `fillPartOptions` / `fillSourceOptions`와 같은 내용을 팝업 칸에 채우는 함수다. **부품 선택칸 맨 위에는 반드시 값이 빈 항목을 둔다** — 등록 폼이 같은 이유로 그렇게 되어 있다(첫 항목이 말없이 골라지는 것을 막기 위해).

- [ ] **Step 4: 닫기 버튼을 붙인다**

```javascript
    el("ud-close-btn").addEventListener("click", () => {
        el("usage-dialog").close();
        openUsage = null;
    });
```

- [ ] **Step 5: 문법 확인과 눈으로 확인**

```
node --check web/js/pages/usage.js
```

배포 후 사용자에게 요청: 사용이력에서 행을 두 번 눌러 팝업이 열리고 값이 채워지는지, 한 번 클릭은 여전히 BOQ 이동이 뜨는지 확인.

- [ ] **Step 6: 커밋**

```bash
git add web/index.html web/js/pages/usage.js
git commit -m "사용이력 수정 팝업 - 뼈대와 열기

행을 두 번 누르면 열린다. 한 번 클릭은 지금처럼 BOQ 이동이다.
관리자가 아니면 아예 열리지 않는다.

값을 다 채운 뒤에야 저장·삭제 버튼을 푼다. 불러오기가 실패한 창에서
버튼이 눌리면 안 된다.

반납이 등록된 건과 자재가 연결 안 된 옛 이력은 열자마자 안내한다."
```

---

### Task 7: 재고 미리보기, 저장, 삭제

**Files:**
- Modify: `web/js/pages/usage.js`
- Modify: `verify_web.py` (검사 추가)

**Interfaces:**
- Consumes: `updateUsage(id, values)`, `deleteUsage(id)`, `insertAuditLog`
- Produces: 없음 (마지막 작업)

- [ ] **Step 1: 재고가 어떻게 바뀌는지 보여준다**

팝업의 값이 바뀔 때마다 갱신한다. 규칙은 화면 쪽 `MATERIAL_SOURCES`를 쓴다.

```javascript
// 저장하면 재고가 어떻게 움직이는지 미리 보여줍니다.
// 사용자가 자재나 출처를 바꿨을 때 무슨 일이 일어나는지 모르고 저장하는 것을 막습니다.
function updateStockHint() {
    if (!openUsage) return;
    const oldDeduct = MATERIAL_SOURCES[openUsage.manager] === true;
    const newSource = el("ud-source").value;
    const newDeduct = MATERIAL_SOURCES[newSource] === true;
    const newMatId = el("ud-part").value ? Number(el("ud-part").value) : null;
    const newQty = Number(el("ud-qty").value) || 0;

    const moves = new Map();   // 자재 id -> 증감
    if (oldDeduct && openUsage.material_id != null) {
        moves.set(openUsage.material_id,
            (moves.get(openUsage.material_id) ?? 0) + openUsage.quantity);
    }
    if (newDeduct && newMatId != null) {
        moves.set(newMatId, (moves.get(newMatId) ?? 0) - newQty);
    }

    const lines = [];
    for (const [matId, delta] of moves) {
        if (delta === 0) continue;
        const m = materials.find((x) => x.id === matId);
        const name = m ? m["부품명(규격)"] : `자재 ${matId}`;
        const now = m ? m["현재재고"] : null;
        const after = now == null ? null : now + delta;
        lines.push(`'${name}' ${delta > 0 ? "+" : ""}${delta}`
            + (now == null ? "" : ` (${now} → ${after})`)
            + (after != null && after < 0 ? "  ⚠️ 음수가 됩니다" : ""));
    }
    if (oldDeduct && !newDeduct) lines.push("수리 관리에서 이 건이 사라집니다.");

    el("ud-stock-hint").textContent =
        lines.length ? `저장하면: ${lines.join(" / ")}` : "재고는 바뀌지 않습니다.";
}
```

`materials`에 `현재재고`가 없으면 `getMaterialOptions`가 그 칸을 함께 돌려주도록 넓힌다.

- [ ] **Step 2: 값이 바뀔 때마다 부르게 한다**

```javascript
    for (const id of ["ud-part", "ud-source", "ud-qty"]) {
        el(id).addEventListener("change", updateStockHint);
    }
    el("ud-qty").addEventListener("input", updateStockHint);
```

- [ ] **Step 3: 저장을 붙인다**

```javascript
    el("ud-save-btn").addEventListener("click", async () => {
        if (!openUsage) return;
        const target = openUsage;          // ⚠️ await 전에 읽어둡니다
        const values = {
            occurred_on: el("ud-date").value,
            material_id: el("ud-part").value ? Number(el("ud-part").value) : null,
            quantity: Number(el("ud-qty").value),
            manager: el("ud-source").value,
            equipment_id: el("ud-equipment").value || null,
            problem: el("ud-problem").value || null,
            action_taken: el("ud-action").value || null,
            part_memo: el("ud-part-memo").value || null,
            note: el("ud-note").value || null,
        };
        el("ud-save-btn").disabled = true;
        setStatus("ud-dialog-status", "저장하는 중...");
        try {
            await updateUsage(target.id, values);
        } catch (err) {
            setStatus("ud-dialog-status", describeError(err, "저장하지 못했습니다."), "error");
            el("ud-save-btn").disabled = false;
            return;
        }
        await insertAuditLog(currentEmail(), "출고이력 수정", values.material_id,
                             target.part_name, target, values);
        el("usage-dialog").close();
        openUsage = null;
        await load(true);
        setStatus("usage-status", "출고 이력을 고쳤습니다.", "ok");
    });
```

> ⚠️ `target`을 `await` 앞에서 읽는 것이 중요하다. 이 저장소에서 **`await` 뒤에 값을 읽었다가 엉뚱한 값이 저장된 회귀가 실제로 있었다**(`565a3f2` 커밋).

- [ ] **Step 4: 삭제를 붙인다**

```javascript
    el("ud-delete-confirm").addEventListener("change", () => {
        el("ud-delete-btn").disabled = !el("ud-delete-confirm").checked;
    });

    el("ud-delete-btn").addEventListener("click", async () => {
        if (!openUsage) return;
        const target = openUsage;
        el("ud-delete-btn").disabled = true;
        setStatus("ud-dialog-status", "지우는 중...");
        try {
            await deleteUsage(target.id);
        } catch (err) {
            setStatus("ud-dialog-status", describeError(err, "지우지 못했습니다."), "error");
            el("ud-delete-btn").disabled = false;
            return;
        }
        await insertAuditLog(currentEmail(), "출고이력 삭제", target.material_id,
                             target.part_name, target, null);
        el("usage-dialog").close();
        openUsage = null;
        await load(true);
        setStatus("usage-status", "출고 이력을 지웠습니다.", "ok");
    });
```

- [ ] **Step 5: `verify_web.py`에 검사를 추가한다**

`[5]` 사용이력 부분에 넣는다.

```python
            # 관리자만 열립니다. 한 번 클릭은 BOQ 이동이라 두 번 클릭과 구분됩니다.
            page.click("#usage-table .tabulator-row")
            check("한 번만 누르면 수정 팝업이 열리지 않는다",
                  not page.locator("#usage-dialog[open]").count())
            page.dblclick("#usage-table .tabulator-row")
            page.wait_for_selector("#usage-dialog[open]", timeout=15000)
            check("행을 두 번 누르면 수정 팝업이 열린다", True)
            page.wait_for_function(
                "document.querySelectorAll('#ud-part option').length > 0", timeout=15000)
            check("팝업의 부품 선택칸이 채워진다",
                  page.locator("#ud-part option").count() > 0)
            check("삭제 버튼은 확인 전까지 잠겨 있다",
                  page.locator("#ud-delete-btn").is_disabled())
            page.click("#ud-close-btn")
```

- [ ] **Step 6: 사용자에게 배포와 검사를 요청한다**

`git push` 후 배포를 기다렸다가:

```
python verify_web.py
```

기대: 전체 통과(기존 30개 + 새 4개). 그다음 화면에서 직접 한 건을 고쳐 보고 재고가 미리보기대로 움직였는지 자재 목록에서 확인한다.

- [ ] **Step 7: 커밋**

```bash
git add web/js/pages/usage.js verify_web.py
git commit -m "사용이력 수정 팝업 - 재고 미리보기, 저장, 삭제

저장을 누르기 전에 재고가 어떻게 움직이는지 보여준다. 자재나 출처를 바꿨을 때
무슨 일이 일어나는지 모르고 저장하는 것을 막는다. 음수가 되면 경고하되 막지는
않는다 - 음수를 허용하기로 한 기존 방침대로다.

저장·삭제 모두 await 전에 대상을 읽어둔다. 이 저장소에서 await 뒤에 값을
읽었다가 엉뚱한 값이 저장된 회귀가 있었다(565a3f2).

삭제는 확인 체크박스를 켜야 눌린다. 자재 목록과 같다.
verify_web.py 에 검사 네 개 추가."
```

---

## 마무리

- [ ] `자재이관_주의사항.md`나 `시스템_규칙과_배경.md`에 **출고 이력을 고칠 수 있다는 것**과 **재고 규칙이 화면·DB 두 군데 있다는 것**을 적는다.
- [ ] `web/PORTING.md`의 사용이력 항목에 수정·삭제를 추가한다.
- [ ] 사용자에게 `/code-review high` 를 권한다. 재고를 건드리는 변경이라 리뷰 가치가 크다.
