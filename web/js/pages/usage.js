// 사용(출고) 이력 화면입니다. 이력을 표로 보여주고, 아래에서 새 출고를 등록합니다.
// 입고(구매) 이력은 '구매 요청' 쪽에서 따로 관리합니다.
import {
    getUsageHistory, getMaterialOptions, getMaterial, registerUsage,
    getUsage, updateUsage, deleteUsage, insertAuditLog,
} from "../db.js";
import { renderTable, downloadTableExcel } from "../table.js";
import { setStatus, describeError, today, esc, refill } from "../ui.js";

const el = (id) => document.getElementById(id);

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

let materials = [];        // 부품 선택칸에 쓸 자재 목록 (id, 카테고리, 부품명(규격), 창고번호, 현재재고)
let loaded = false;
let loadSeq = 0;           // 불러오기 순번 (늦게 시작한 것만 화면에 그리려고)
let dateTouched = false;   // 사람이 일자 칸을 직접 고쳤는지
let lastUserKey = null;    // 로그인한 사람이 바뀌었는지 가리는 값
let onJumpToBoq = null;    // 표에서 설비를 고르면 BOQ 검색으로 넘기는 함수
let isAdmin = false;
let currentEmail = "";
let openUsage = null;       // 지금 팝업에 열려 있는 출고 이력 (DB에서 새로 읽은 값)
let busyUsage = false;      // 팝업의 저장·삭제가 DB 응답을 기다리는 중인지


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
            // 한 번 클릭은 위에서 이미 BOQ 이동에 쓰고 있으므로 그대로 두고, 수정은
            // 두 번 클릭에 붙입니다. 관리자가 아니면 아예 붙이지 않습니다.
            onRowDblClick: isAdmin ? (row) => openDialog(row.id) : null,
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
export function setUser(session, admin) {
    isAdmin = admin;
    currentEmail = session?.user?.email ?? "";

    // 관리자 여부도 키에 넣습니다 — 더블클릭 수정 팝업을 붙일지가 이 값에 달려 있어서,
    // 이메일이 같아도 권한이 바뀌면 표를 다시 그려야 합니다(materials.js·purchase.js와 같은 이유).
    // 로그아웃(session이 없음)은 예전처럼 무조건 비웁니다 — 공용 계정이라 이메일만 보면
    // 정작 사람이 바뀌는 경우를 놓칩니다.
    const key = session ? `${currentEmail}|${admin}` : "";
    if (session && key === lastUserKey) return;

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
    // 로그아웃 경로(session이 없음)는 main.js가 열린 팝업을 전부 닫아 줍니다(dialog[open]).
    // 하지만 로그인 상태를 유지한 채 관리자 여부만 바뀌어 setUser가 다시 불리는 경로는
    // main.js가 팝업을 닫지 않으므로, 열려 있던 팝업이 있으면 여기서 직접 닫습니다.
    // 저장·삭제는 openUsage가 null이면 막히므로 위험하지는 않지만, 그대로 두면 버튼이
    // 눌러도 조용히 반응하지 않는 팝업이 화면에 남습니다.
    const openDialogEl = document.getElementById("usage-dialog");
    if (openDialogEl.open) openDialogEl.close();
    openUsage = null;
    busyUsage = false;
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


// ---------------------------------------------------------------------------
// 수정/삭제 팝업 (관리자만, 행을 두 번 클릭하면 열립니다)
// ---------------------------------------------------------------------------

// 팝업의 카테고리 선택칸을 채웁니다. select에 넣을 값을 인자로 받습니다 — 팝업을 열 때는
// 그 기록의 자재가 속한 카테고리를 미리 골라줘야, 부품 목록이 그 카테고리로 좁혀진 채로
// 열립니다. 목록에 없는 값(자재가 안 연결된 기록 등)이면 '전체'로 둡니다.
function fillDialogCategoryOptions(selected) {
    const categories = [...new Set(materials.map((m) => m["카테고리"]).filter(Boolean))].sort();
    refill(el("ud-category"),
        ["전체", ...categories].map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join(""));
    el("ud-category").value = categories.includes(selected) ? selected : "전체";
}


// 팝업의 부품 선택칸을 채웁니다. 등록 폼의 fillPartOptions와 같은 이유로 맨 위에 빈 항목을
// 둡니다 — 다시 그리면 브라우저가 첫 항목을 자동으로 고르는데, 그게 실제 자재이면 사람이
// 모르는 사이에 엉뚱한 자재로 바뀐 채 저장될 수 있습니다.
function fillDialogPartOptions() {
    const category = el("ud-category").value;
    const list = category === "전체" ? materials : materials.filter((m) => m["카테고리"] === category);

    refill(el("ud-part"), [`<option value="">부품을 선택하세요</option>`, ...list.map((m) => {
        const warehouse = m["창고번호"] ? ` · 창고 ${m["창고번호"]}` : "";
        return `<option value="${m.id}">${esc(m["부품명(규격)"])}${esc(warehouse)}</option>`;
    })].join(""));
}


// 팝업의 자재 출처 선택칸을 채웁니다. 등록 폼과 같은 목록에 맨 위 빈 항목을 더합니다.
// currentValue(지금 이 기록의 출처)가 목록에 없으면(옛 기록에 직접 입력으로 남은 값 등)
// 목록 맨 끝에 끼워 넣습니다. 안 그러면 선택칸이 빈 채로 열려서, 손대지 않고 저장해도
// 출처가 조용히 지워집니다.
function fillDialogSourceOptions(currentValue) {
    const options = [...Object.keys(MATERIAL_SOURCES), CUSTOM_SOURCE];
    const all = currentValue && !options.includes(currentValue) ? [...options, currentValue] : options;
    refill(el("ud-source"),
        [`<option value="">출처를 선택하세요</option>`,
            ...all.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)].join(""));
}


// 창 안에서 무언가를 하는 버튼 전부입니다. materials.js의 DIALOG_BUTTONS와 같은 이유로
// 하나가 DB 응답을 기다리는 동안 나머지도 같이 잠급니다. 닫기까지 잠그는 것은, 저장을
// 기다리는 사이에 창을 닫고 다른 행을 열면 뒤늦게 온 응답이 새로 연 창의 openUsage를
// 건드려 엉뚱한 이력이 닫히거나 지워질 수 있기 때문입니다.
const USAGE_DIALOG_BUTTONS = ["ud-save-btn", "ud-delete-btn", "ud-dialog-close", "ud-delete-confirm"];

function setUsageBusy(on) {
    busyUsage = on;
    for (const id of USAGE_DIALOG_BUTTONS) el(id).disabled = on;

    if (!on) {
        // 이력을 못 불러온 창이면 저장·삭제는 잠긴 채로 둡니다.
        el("ud-save-btn").disabled = !openUsage;
        el("ud-delete-confirm").disabled = !openUsage;
        // 삭제는 "삭제하겠습니다"에 체크가 되어 있을 때만 다시 풉니다.
        el("ud-delete-btn").disabled = !openUsage || !el("ud-delete-confirm").checked;
    }
}


// 창 안의 모든 칸을 비우고 버튼을 잠급니다. materials.js의 resetDialog와 같은 이유로
// 창을 띄우기 "전에" 반드시 불러야 합니다 — 앞서 열었던 기록의 값이 남아 있으면, 새
// 기록을 불러오는 짧은 사이에 그 값이 그대로 보이고 삭제 버튼까지 살아 있을 수 있습니다.
function resetUsageDialog() {
    for (const id of ["ud-date", "ud-part", "ud-source", "ud-qty",
        "ud-equipment", "ud-problem", "ud-action", "ud-part-memo", "ud-note"]) {
        el(id).value = "";
    }
    el("ud-category").innerHTML = "";
    el("ud-stock-hint").textContent = "";

    el("ud-delete-details").open = false;
    el("ud-delete-confirm").checked = false;
    el("ud-delete-confirm").disabled = true;
    el("ud-delete-btn").disabled = true;
    el("ud-save-btn").disabled = true;
}


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


// 표에 그려둔 값이 아니라 DB에서 새로 읽은 값으로 칸을 채웁니다.
// 화면을 오래 열어둔 사이에 다른 사람이 고쳤을 수 있기 때문입니다.
async function openDialog(id) {
    openUsage = null;
    resetUsageDialog();
    setStatus("ud-dialog-status", "불러오는 중...");
    el("usage-dialog").showModal();

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

    // 자재가 연결된 기록이면 그 자재의 카테고리로 부품 목록을 미리 좁혀서 보여줍니다.
    const mat = fresh.material_id != null ? materials.find((m) => m.id === fresh.material_id) : null;
    fillDialogCategoryOptions(mat ? mat["카테고리"] : "전체");
    fillDialogPartOptions();
    fillDialogSourceOptions(fresh.manager);

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
    } else {
        setStatus("ud-dialog-status", "");
    }

    el("ud-save-btn").disabled = false;
    el("ud-delete-confirm").disabled = false;
    openUsage = fresh;
    updateStockHint();
}


function initUsageDialog() {
    el("ud-dialog-close").addEventListener("click", () => {
        if (busyUsage) return;
        el("usage-dialog").close();
        openUsage = null;
    });
    // Esc 키도 같은 이유로 막습니다. ✕ 버튼만 잠그면 Esc로 빠져나갈 수 있습니다.
    el("usage-dialog").addEventListener("cancel", (e) => {
        if (busyUsage) e.preventDefault();
    });

    el("ud-category").addEventListener("change", () => {
        fillDialogPartOptions();
        updateStockHint();
    });
    for (const id of ["ud-part", "ud-source"]) {
        el(id).addEventListener("change", updateStockHint);
    }
    // 수량은 change보다 input이 더 자주 불려서(끄는 즉시 반영) input 하나만 씁니다.
    el("ud-qty").addEventListener("input", updateStockHint);

    el("usage-dialog-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!openUsage) return;
        const target = openUsage;          // ⚠️ await 전에 읽어둡니다 (565a3f2 회귀 재발 방지)
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

        if (!values.manager) {
            setStatus("ud-dialog-status", "자재 출처를 선택해주세요.", "error");
            return;
        }
        // 자재는 조건부 필수입니다: 원래 자재가 연결돼 있던 기록에서 비운 채 저장하는 것만
        // 막습니다. 2026-07 이관분처럼 원래 자재가 없던 기록은 비워 둔 채 저장할 수 있어야
        // 설비ID 오타 등을 자재 지정 없이 고칠 수 있습니다.
        if (target.material_id != null && !values.material_id) {
            setStatus("ud-dialog-status",
                "이미 자재가 연결된 기록입니다. 부품을 비운 채로 저장할 수 없습니다.", "error");
            return;
        }

        setUsageBusy(true);
        setStatus("ud-dialog-status", "저장하는 중...");
        try {
            await updateUsage(target.id, values);
        } catch (err) {
            setStatus("ud-dialog-status", describeError(err, "저장하지 못했습니다."), "error");
            setUsageBusy(false);
            return;
        }

        // 저장은 이미 끝났습니다. 감사 로그가 실패해도 저장을 되돌리지 않고, "저장은 됐지만
        // 기록은 못 남겼다"고 사실대로 알립니다(materials.js의 saveMaterial과 같은 방식).
        const warnings = [];
        try {
            await insertAuditLog(currentEmail, "출고이력 수정", values.material_id,
                target.part_name, target, values);
        } catch (err) {
            warnings.push(describeError(err, "감사 로그를 남기지 못했습니다."));
        }

        el("usage-dialog").close();
        openUsage = null;
        setUsageBusy(false);
        await load(true);
        setStatus("usage-status",
            warnings.length ? `출고 이력을 고쳤습니다.\n\n다만: ${warnings.join("\n다만: ")}` : "출고 이력을 고쳤습니다.",
            warnings.length ? "warn" : "ok");
    });

    el("ud-delete-confirm").addEventListener("change", () => {
        // 처리 중에는 손대지 않습니다. setUsageBusy가 잠가둔 삭제 버튼이 체크 한 번으로
        // 되살아나면 잠금을 만든 의미가 없어집니다.
        if (busyUsage) return;
        el("ud-delete-btn").disabled = !el("ud-delete-confirm").checked;
    });

    el("ud-delete-btn").addEventListener("click", async () => {
        if (!openUsage) return;
        const target = openUsage;          // ⚠️ await 전에 읽어둡니다
        setUsageBusy(true);
        setStatus("ud-dialog-status", "지우는 중...");
        try {
            await deleteUsage(target.id);
        } catch (err) {
            setStatus("ud-dialog-status", describeError(err, "지우지 못했습니다."), "error");
            setUsageBusy(false);
            return;
        }

        const warnings = [];
        try {
            await insertAuditLog(currentEmail, "출고이력 삭제", target.material_id,
                target.part_name, target, null);
        } catch (err) {
            warnings.push(describeError(err, "감사 로그를 남기지 못했습니다."));
        }

        el("usage-dialog").close();
        openUsage = null;
        setUsageBusy(false);
        await load(true);
        setStatus("usage-status",
            warnings.length ? `출고 이력을 지웠습니다.\n\n다만: ${warnings.join("\n다만: ")}` : "출고 이력을 지웠습니다.",
            warnings.length ? "warn" : "ok");
    });
}


export function init(jumpToBoq) {
    onJumpToBoq = jumpToBoq;
    initUsageDialog();

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
