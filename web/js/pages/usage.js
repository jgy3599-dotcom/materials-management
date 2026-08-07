// 사용(출고) 이력 화면입니다. 이력을 표로 보여주고, 아래에서 새 출고를 등록합니다.
// 입고(구매) 이력은 '구매 요청' 쪽에서 따로 관리합니다.
import { getUsageHistory, getMaterials, getMaterial, registerUsage } from "../db.js";
import { renderTable, downloadTableExcel } from "../table.js";
import { setStatus, describeError, today, esc } from "../ui.js";

// 표에 보여줄 컬럼입니다. '구분'은 이 화면이 전부 출고라서 값이 늘 같아 뺐습니다.
const COLUMNS = ["일자", "부품명(규격)", "수량", "자재 출처", "설비ID", "문제", "조치", "부품메모", "비고"];
const TABLE_ID = "usage-table";

// "자재 출처"는 이 자재를 어느 소속에서 썼는지 기록합니다. 값(true/false)은 그 출처를
// 썼을 때 우리 재고에서 차감할지 여부입니다(한진 소유 자재만 차감, 실무 확인 결과).
// 출처를 추가/변경할 때 이 한 곳만 고치면 선택지와 차감 여부가 같이 바뀝니다.
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
let onJumpToBoq = null;    // 표에서 설비를 고르면 BOQ 검색으로 넘기는 함수


// 부품 선택칸을 채웁니다.
//
// 값으로 부품명이 아니라 자재 id를 씁니다. 부품명이 같은 자재가 여러 건 등록돼 있어서
// (실측 24종 64건), 이름으로 되찾으면 늘 첫 번째 것이 골라져 엉뚱한 자재의 재고가
// 깎일 수 있기 때문입니다. 화면에 보이는 글자에는 창고번호를 붙여 사람이 구분하게 합니다.
function fillPartOptions() {
    const category = document.getElementById("usage-category").value;
    const select = document.getElementById("usage-part");
    const list = category === "전체" ? materials : materials.filter((m) => m["카테고리"] === category);

    select.innerHTML = list.map((m) => {
        const warehouse = m["창고번호"] ? ` · 창고 ${m["창고번호"]}` : "";
        return `<option value="${m.id}">${esc(m["부품명(규격)"])}${esc(warehouse)}</option>`;
    }).join("");

    document.getElementById("usage-part-count").textContent = `${list.length}건`;
}


function fillCategoryOptions() {
    const categories = [...new Set(materials.map((m) => m["카테고리"]).filter(Boolean))].sort();
    document.getElementById("usage-category").innerHTML =
        ["전체", ...categories].map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
}


function fillSourceOptions() {
    const options = [...Object.keys(MATERIAL_SOURCES), CUSTOM_SOURCE];
    document.getElementById("usage-source").innerHTML =
        options.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
    updateSourceHint();
}


// 지금 고른 출처가 재고를 깎는지 화면에 알려줍니다.
// Streamlit 앱에는 없던 안내인데, 재고가 안 줄어든다고 오해하기 쉬운 부분이라 넣었습니다.
function updateSourceHint() {
    const source = document.getElementById("usage-source").value;
    const custom = document.getElementById("usage-custom-source");
    const hint = document.getElementById("usage-source-hint");

    custom.classList.toggle("hidden", source !== CUSTOM_SOURCE);

    if (MATERIAL_SOURCES[source]) {
        hint.textContent = `'${source}'는 한진 소유 자재라 현재재고가 차감되고, 수리 관리에도 자동 등록됩니다.`;
    } else {
        hint.textContent = `'${source}'는 한진 소유 자재가 아니라 재고가 차감되지 않습니다 (이력만 기록).`;
    }
}


export async function load(force = false) {
    if (loaded && !force) return;

    setStatus("usage-status", "불러오는 중...");
    try {
        const [history, mats] = await Promise.all([getUsageHistory(), getMaterials()]);
        materials = mats;

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
        document.getElementById("usage-date").value = today();

        setStatus("usage-status", "");
        loaded = true;
    } catch (err) {
        setStatus("usage-status", describeError(err, "사용 이력을 불러오지 못했습니다."), "error");
    }
}


async function submit(e) {
    e.preventDefault();

    const source = document.getElementById("usage-source").value;
    const custom = document.getElementById("usage-custom-source").value.trim();
    const materialId = document.getElementById("usage-part").value;

    if (source === CUSTOM_SOURCE && !custom) {
        setStatus("usage-form-status", "자재 출처 '직접 입력'을 선택했으면 옆 칸에 출처를 입력해주세요.", "error");
        return;
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
            // "직접 입력"은 MATERIAL_SOURCES에 없는 값이라 항상 차감되지 않습니다.
            manager: source === CUSTOM_SOURCE ? custom : source,
            deductStock: MATERIAL_SOURCES[source] ?? false,
            equipmentId: document.getElementById("usage-equipment").value.trim(),
            problem: document.getElementById("usage-problem").value.trim(),
            actionTaken: document.getElementById("usage-action").value.trim(),
            partMemo: document.getElementById("usage-memo").value.trim(),
            note: document.getElementById("usage-note").value.trim(),
        });

        const partName = document.getElementById("usage-part").selectedOptions[0]?.textContent ?? "";
        document.getElementById("usage-form").reset();
        document.getElementById("usage-date").value = today();
        fillSourceOptions();

        await load(true);   // 표와 재고를 새로 읽어옵니다

        // 차감한 뒤 재고가 음수면, 있는 것보다 많이 나갔다는 뜻이라 기록 어딘가가
        // 어긋난 것입니다. 막지는 않지만(실제로 음수인 자재가 있습니다) 그냥 넘어가면
        // 아무도 모르므로 등록 직후에 짚어줍니다.
        //
        // 목록이 아니라 그 자재만 DB에서 새로 읽습니다. 위의 load()는 실패해도 조용히
        // 넘어가서, 목록에는 차감 전 값이 남아 있을 수 있기 때문입니다.
        let left = null;
        try {
            left = (await getMaterial(Number(materialId)))?.current_qty ?? null;
        } catch {
            // 못 읽으면 경고 없이 성공 안내만 합니다. 표에는 음수가 빨갛게 보입니다.
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
    document.getElementById("usage-source").addEventListener("change", updateSourceHint);
    document.getElementById("usage-form").addEventListener("submit", submit);

    document.getElementById("usage-jump-btn").addEventListener("click", (e) => {
        const id = e.currentTarget.dataset.equipmentId;
        if (id) onJumpToBoq?.(id);
    });
}
