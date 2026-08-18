// 사용(출고) 이력 화면입니다. 이력을 표로 보여주고, 아래에서 새 출고를 등록합니다.
// 입고(구매) 이력은 '구매 요청' 쪽에서 따로 관리합니다.
import { getUsageHistory, getMaterialOptions, getMaterial, registerUsage } from "../db.js";
import { renderTable, downloadTableExcel } from "../table.js";
import { setStatus, describeError, today, esc } from "../ui.js";

// 표에 보여줄 컬럼입니다. '구분'은 이 화면이 전부 출고라서 값이 늘 같아 뺐습니다.
const COLUMNS = ["일자", "부품명(규격)", "수량", "자재 출처", "설비ID", "문제", "조치", "부품메모", "비고"];
const TABLE_ID = "usage-table";

// "자재 출처"는 이 자재를 어느 소속에서 썼는지 기록합니다. 값(true/false)은 그 출처를
// 썼을 때 우리 재고에서 차감할지 여부입니다(한진 소유 자재만 차감, 실무 확인 결과).
// 출처를 추가/변경할 때 이 한 곳만 고치면 선택지와 차감 여부가 같이 바뀝니다.
// 자재 출처별로 현재재고를 깎는지 여부입니다.
//
// ⚠️ 같은 규칙이 DB에도 있습니다 — supabase_setup.sql 의 usage_deducts_stock().
//    출고 등록은 이 값을 보고 p_deduct_stock 을 넘기지만, 출고 수정·삭제는 DB 함수가
//    스스로 판단합니다(옛 출처가 깎였는지를 알아야 하므로). 한쪽만 고치면 등록과
//    수정이 서로 다르게 동작해 재고가 조용히 어긋납니다.
//    이 규칙은 두 번 뒤집혔던 이력이 있습니다(시스템_규칙과_배경.md 1절).
const MATERIAL_SOURCES = {
    "보우": false,
    "POSCO": false,
    "한진 SPARE": true,
    "한진 구매품": true,
    "BEUMER": false,
};
const CUSTOM_SOURCE = "직접 입력";

let materials = [];        // 부품 선택칸에 쓸 자재 목록
let loaded = false;
let loadSeq = 0;           // 불러오기 순번 (늦게 시작한 것만 화면에 그리려고)
let dateTouched = false;   // 사람이 일자 칸을 직접 고쳤는지
let lastUserKey = null;    // 로그인한 사람이 바뀌었는지 가리는 값
let onJumpToBoq = null;    // 표에서 설비를 고르면 BOQ 검색으로 넘기는 함수


// 선택칸을 다시 그리면 골라둔 값이 첫 번째 것으로 되돌아갑니다. 폼을 채우던 중에
// 새로고침을 누르면 글로 쓴 칸은 남고 선택칸만 바뀌어서, 폼이 멀쩡해 보이는 채로
// 엉뚱한 자재의 재고가 깎일 수 있습니다. 그래서 다시 그리기 전에 고른 값을 기억했다가
// 그 값이 아직 목록에 있으면 되돌려 놓습니다.
function refill(select, html) {
    const keep = select.value;
    select.innerHTML = html;
    if (keep && [...select.options].some((o) => o.value === keep)) select.value = keep;
}


// 부품 선택칸을 채웁니다.
//
// 값으로 부품명이 아니라 자재 id를 씁니다. 부품명이 같은 자재가 여러 건 등록돼 있어서
// (실측 24종 64건), 이름으로 되찾으면 늘 첫 번째 것이 골라져 엉뚱한 자재의 재고가
// 깎일 수 있기 때문입니다. 화면에 보이는 글자에는 창고번호를 붙여 사람이 구분하게 합니다.
function fillPartOptions() {
    const category = document.getElementById("usage-category").value;
    const select = document.getElementById("usage-part");
    const list = category === "전체" ? materials : materials.filter((m) => m["카테고리"] === category);

    // 맨 위에 빈 항목을 둡니다. 선택칸을 다시 그리면 브라우저가 첫 항목을 자동으로 고르는데,
    // 그게 실제 자재이면 사람이 모르는 사이에 엉뚱한 자재가 골라진 채로 등록될 수 있습니다.
    // 빈 항목이 첫 자리에 있으면 그런 경우 값이 비고, 아래 submit()의 "부품을 선택해주세요"
    // 검사에 걸려 사람이 반드시 다시 고르게 됩니다.
    refill(select, [`<option value="">부품을 선택하세요</option>`, ...list.map((m) => {
        const warehouse = m["창고번호"] ? ` · 창고 ${m["창고번호"]}` : "";
        return `<option value="${m.id}">${esc(m["부품명(규격)"])}${esc(warehouse)}</option>`;
    })].join(""));

    document.getElementById("usage-part-count").textContent = `${list.length}건`;
}


function fillCategoryOptions() {
    const categories = [...new Set(materials.map((m) => m["카테고리"]).filter(Boolean))].sort();
    refill(document.getElementById("usage-category"),
        ["전체", ...categories].map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join(""));
}


function fillSourceOptions() {
    const options = [...Object.keys(MATERIAL_SOURCES), CUSTOM_SOURCE];
    // 부품 칸과 같은 이유로 맨 위에 빈 항목을 둡니다. 목록의 첫 항목이 '보우'인데, 그건
    // 재고를 깎지 않는 출처입니다. 등록을 마쳐 폼이 비워지면 출처가 말없이 '보우'로
    // 돌아가므로, 한진 자재를 연달아 등록할 때 두 번째부터 재고가 안 깎일 수 있습니다.
    refill(document.getElementById("usage-source"),
        [`<option value="">출처를 선택하세요</option>`,
            ...options.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)].join(""));
    updateSourceHint();
}


// 지금 고른 출처가 재고를 깎는지 화면에 알려줍니다.
// Streamlit 앱에는 없던 안내인데, 재고가 안 줄어든다고 오해하기 쉬운 부분이라 넣었습니다.
function updateSourceHint() {
    const source = document.getElementById("usage-source").value;
    const custom = document.getElementById("usage-custom-source");
    const hint = document.getElementById("usage-source-hint");

    custom.classList.toggle("hidden", source !== CUSTOM_SOURCE);

    // 아직 안 골랐으면(맨 위 빈 항목) 차감 여부를 말할 수 없으므로 문구를 비웁니다.
    if (!source) {
        hint.textContent = "";
        return;
    }

    if (MATERIAL_SOURCES[source]) {
        hint.textContent = `'${source}'는 한진 소유 자재라 현재재고가 차감되고, 수리 관리에도 자동 등록됩니다.`;
    } else {
        hint.textContent = `'${source}'는 한진 소유 자재가 아니라 재고가 차감되지 않습니다 (이력만 기록).`;
    }
}


// 표에서 고른 설비로 넘어가는 버튼을 숨깁니다. 눌리는 버튼이라 예전 설비를 가리킨 채
// 남아 있으면 안 됩니다.
function clearJump() {
    document.getElementById("usage-jump").classList.add("hidden");
    document.getElementById("usage-jump-btn").dataset.equipmentId = "";
}


export async function load(force = false) {
    // 일자 맞추기는 표를 다시 읽지 않는 경우에도 합니다. 이 화면은 한 번 읽으면 아래에서
    // 바로 빠져나가는데, 그러면 화면을 열어둔 채 자정을 넘겼을 때 메뉴를 오갔다 와도
    // 어제 날짜가 그대로 남기 때문입니다(야간 작업).
    //
    // 사람이 직접 고친 일자는 건드리지 않습니다 — 어제 것을 등록하려고 고쳐놓은 값이
    // 새로고침 한 번에 오늘로 되돌아가면 안 됩니다.
    // (다만 화면을 열어둔 채 아무 데도 가지 않고 자정을 넘기면 이 맞추기도 돌지 않습니다.
    //  그 경우는 로그인 1시간 제한에 걸려 다시 로그인하면서 초기화됩니다.)
    // 칸을 아예 비운 경우에도 채웁니다. 날짜 칸의 지우기 단추로 값을 지우면 '사람이 고쳤다'로
    // 기록되는데, 그대로 두면 빈 칸이 계속 남아 등록 자체가 안 됩니다(required).
    const date = document.getElementById("usage-date");
    if (!dateTouched || !date.value) {
        date.value = today();
        // 우리가 채워 넣은 값은 '사람이 고른 값'이 아니므로 표시를 내립니다. 안 그러면
        // 칸을 한 번 비운 것만으로 그 뒤의 날짜 맞추기가 계속 막힙니다.
        dateTouched = false;
    }

    if (loaded && !force) return;

    // 새로고침을 연달아 누르거나, 불러오는 중에 출고를 등록하면 불러오기가 겹쳐 돕니다.
    // 그때 먼저 시작한 쪽이 늦게 끝나면 낡은 내용(예: 방금 등록한 행이 없는 표)으로
    // 덮어써 버립니다. 그래서 순번을 매겨 두고, 나보다 나중에 시작한 것이 있으면
    // 받아온 내용을 그리지 않고 조용히 물러납니다.
    const seq = ++loadSeq;

    setStatus("usage-status", "불러오는 중...");
    try {
        const [history, mats] = await Promise.all([getUsageHistory(), getMaterialOptions()]);
        if (seq !== loadSeq) return;
        materials = mats;

        // 표를 다시 그리면 골랐던 행이 풀립니다. 이동 버튼을 그대로 두면 아무 행도
        // 선택되지 않은 채 예전 설비로 넘어가므로 같이 지웁니다.
        clearJump();

        renderTable(TABLE_ID, history, COLUMNS, {
            selectable: true,
            onRowClick: (row) => {
                const id = row["설비ID"];
                document.getElementById("usage-jump").classList.toggle("hidden", !id);
                document.getElementById("usage-jump-btn").textContent = `🔎 '${id}' BOQ 검색으로 이동`;
                document.getElementById("usage-jump-btn").dataset.equipmentId = id ?? "";
            },
        });
        document.getElementById("usage-count").textContent = `총 ${history.length.toLocaleString()}건`;

        fillCategoryOptions();
        fillPartOptions();
        fillSourceOptions();
        setStatus("usage-status", "");
        loaded = true;
    } catch (err) {
        if (seq !== loadSeq) return;
        setStatus("usage-status", describeError(err, "사용 이력을 불러오지 못했습니다."), "error");
        // 다시 읽기에 실패했으면 "이미 읽었다"는 표시를 지웁니다. 안 그러면 메뉴를
        // 오갔다 돌아와도 낡은 내용을 그대로 둡니다.
        loaded = false;
    }
}


// 사람이 바뀌면 앞사람이 적던 폼과 안내 문구를 비우고, 표는 다시 읽도록 되돌립니다.
// 로그아웃할 때(session이 없을 때)와 로그인할 때 양쪽에서 불립니다 — main.js의 render() 참고.
//
// ⚠️ 이메일이 같아도 로그아웃이면 무조건 비웁니다. 일반 사용자는 공용 계정 하나를 여럿이
// 함께 쓰기 때문에, 이메일만 비교하면 정작 사람이 바뀌는 경우에 안 비워집니다. 앞사람이
// 골라둔 부품이 남아 있으면 뒷사람이 설비ID만 채우고 등록해 엉뚱한 재고가 깎입니다.
// 반대로 로그인 상태가 유지되는 동안(토큰 자동 갱신 등)에는 적던 폼을 지우면 안 되므로,
// 그때는 이메일이 같으면 그냥 둡니다.
export function setUser(session) {
    const key = session?.user?.email ?? "";
    if (key && key === lastUserKey) return;

    lastUserKey = key;
    loaded = false;
    dateTouched = false;
    // 순번을 올려서 지금 돌고 있는 불러오기를 무효로 만듭니다. 안 그러면 앞사람 때 시작한
    // 불러오기가 뒤늦게 끝나면서 앞사람이 보던 내용을 그리고 "이미 읽었음"으로 표시해,
    // 뒷사람이 화면을 열어도 다시 읽지 않습니다.
    loadSeq++;
    // 앞사람의 안내 문구("...출고가 등록되었습니다")와 눌리는 이동 버튼도 지웁니다.
    setStatus("usage-status", "");
    setStatus("usage-form-status", "");
    clearJump();
    document.getElementById("usage-form").reset();
    // 앞사람 때 받아온 자재 목록도 버립니다. 남겨두면 뒤이은 다시 읽기가 실패했을 때,
    // 빨간 오류가 뜬 화면에서 앞사람 시점의 목록으로 등록을 시도할 수 있습니다.
    materials = [];
    // 폼을 비우면 카테고리·출처가 첫 항목으로 돌아갑니다. 선택지를 다시 채워서 카테고리
    // 목록과 부품 목록·건수, 안내 문구, '직접 입력' 칸을 거기에 맞춥니다. 카테고리도 같이
    // 채워야, 다시 읽기가 실패했을 때 앞사람 카테고리만 남아 골라도 0건인 화면이 안 됩니다.
    fillCategoryOptions();
    fillPartOptions();
    fillSourceOptions();
}


async function submit(e) {
    e.preventDefault();

    const source = document.getElementById("usage-source").value;
    const custom = document.getElementById("usage-custom-source").value.trim();
    // 자재 id와 화면에 보여줄 이름은 등록을 보내기 "전에" 같이 잡아둡니다. 등록이 오가는
    // 동안 카테고리를 바꾸면 부품 선택칸이 다시 그려져서, 나중에 읽으면 실제로 깎인
    // 자재와 다른 이름을 안내하게 됩니다.
    const partSelect = document.getElementById("usage-part");
    const materialId = partSelect.value;
    const partName = partSelect.selectedOptions[0]?.textContent ?? "";
    // "직접 입력"은 MATERIAL_SOURCES에 없는 값이라 항상 차감되지 않습니다.
    const deductStock = MATERIAL_SOURCES[source] ?? false;

    if (!source) {
        setStatus("usage-form-status", "자재 출처를 선택해주세요.", "error");
        return;
    }
    if (source === CUSTOM_SOURCE) {
        if (!custom) {
            setStatus("usage-form-status", "자재 출처 '직접 입력'을 선택했으면 옆 칸에 출처를 입력해주세요.", "error");
            return;
        }
        // 재고를 깎는 출처(한진 SPARE·한진 구매품)의 이름을 직접 입력으로 적으면, 이력에는
        // 한진 자재로 남는데 재고는 깎이지 않습니다. 나중에 재고와 이력을 대조할 때 원인을
        // 알 수 없는 차이로 남으므로 막습니다.
        //
        // 깎지 않는 출처(보우·POSCO·BEUMER)는 막지 않습니다. 목록에서 골라도 어차피 깎이지
        // 않아 결과가 같으므로, 막으면 "목록에서 고르면 깎인다"고 잘못 알려주게 됩니다.
        const flat = (s) => s.replace(/\s/g, "").toLowerCase();
        const known = Object.keys(MATERIAL_SOURCES).find((s) => MATERIAL_SOURCES[s] && flat(s) === flat(custom));
        if (known) {
            setStatus("usage-form-status",
                `'${known}'는 목록에서 골라야 재고가 차감됩니다. 직접 입력으로 적으면 이력에만 남고 재고는 그대로이니, 목록에서 '${known}'를 골라주세요.`, "error");
            return;
        }
    }
    if (!materialId) {
        setStatus("usage-form-status", "부품을 선택해주세요.", "error");
        return;
    }

    const btn = document.getElementById("usage-submit-btn");
    btn.disabled = true;
    btn.textContent = "등록 중...";
    setStatus("usage-form-status", "");

    try {
        await registerUsage({
            occurredOn: document.getElementById("usage-date").value,
            materialId: Number(materialId),
            quantity: Number(document.getElementById("usage-qty").value),
            manager: source === CUSTOM_SOURCE ? custom : source,
            deductStock,
            equipmentId: document.getElementById("usage-equipment").value.trim(),
            problem: document.getElementById("usage-problem").value.trim(),
            actionTaken: document.getElementById("usage-action").value.trim(),
            partMemo: document.getElementById("usage-memo").value.trim(),
            note: document.getElementById("usage-note").value.trim(),
        });

        document.getElementById("usage-form").reset();
        // reset()은 부품 선택칸을 첫 항목, 곧 맨 위의 빈 항목으로 되돌립니다. 그래서 방금
        // 출고한 부품이 남아 수량만 바꿔 또 누르는 일이 생기지 않습니다.
        document.getElementById("usage-date").value = today();
        dateTouched = false;
        // 카테고리도 '전체'로 돌아가므로 부품 목록을 거기에 맞춰 다시 채웁니다. 아래 load()가
        // 어차피 다시 채우지만, 그건 실패해도 조용히 넘어가서 카테고리 칸은 '전체'인데 부품
        // 목록만 직전 카테고리로 걸러진 채 남을 수 있습니다.
        fillPartOptions();
        fillSourceOptions();

        await load(true);   // 표와 부품 목록을 새로 읽어옵니다 (재고는 아래에서 따로 읽습니다)

        // 차감한 뒤 재고가 음수면, 있는 것보다 많이 나갔다는 뜻이라 기록 어딘가가
        // 어긋난 것입니다. 막지는 않지만(실제로 음수인 자재가 있습니다) 그냥 넘어가면
        // 아무도 모르므로 등록 직후에 짚어줍니다.
        //
        // 목록이 아니라 그 자재만 DB에서 새로 읽습니다. 위의 load()는 실패해도 조용히
        // 넘어가서, 목록에는 차감 전 값이 남아 있을 수 있기 때문입니다.
        //
        // 재고를 깎지 않는 출처(보우·POSCO·BEUMER·직접 입력)는 검사하지 않습니다. 원래부터
        // 음수였던 자재라면, 방금 등록 때문에 음수가 된 것처럼 보이게 되기 때문입니다.
        let left = null;
        if (deductStock) {
            try {
                left = (await getMaterial(Number(materialId)))?.current_qty ?? null;
            } catch {
                // 못 읽으면 경고 없이 성공 안내만 합니다. 표에는 음수가 빨갛게 보입니다.
            }
        }

        // ⚠️ 성공한 등록을 빨간 실패 상자로 보여주면 안 됩니다. 실패한 줄 알고 한 번 더
        // 누르면 이력이 두 번 쌓이고 재고도 두 번 깎입니다.
        setStatus("usage-form-status",
            left !== null && left < 0
                ? `'${partName}' 출고가 등록되었습니다.\n\n⚠️ 이 자재의 현재재고가 ${left}개입니다. 있는 것보다 많이 나간 상태라, 재고나 이력을 확인해보세요.`
                : `'${partName}' 출고가 등록되었습니다.`,
            left !== null && left < 0 ? "warn" : "ok");
    } catch (err) {
        setStatus("usage-form-status", describeError(err, "출고 등록에 실패했습니다."), "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "등록하기";
    }
}


export function init(jumpToBoq) {
    onJumpToBoq = jumpToBoq;

    document.getElementById("usage-excel-btn").addEventListener("click", async () => {
        await downloadTableExcel(TABLE_ID, COLUMNS, "사용이력.xlsx");
    });
    document.getElementById("usage-reload-btn").addEventListener("click", () => load(true));
    document.getElementById("usage-category").addEventListener("change", fillPartOptions);
    document.getElementById("usage-date").addEventListener("input", () => { dateTouched = true; });
    document.getElementById("usage-source").addEventListener("change", updateSourceHint);
    document.getElementById("usage-form").addEventListener("submit", submit);

    document.getElementById("usage-jump-btn").addEventListener("click", (e) => {
        const id = e.currentTarget.dataset.equipmentId;
        if (id) onJumpToBoq?.(id);
    });
}
