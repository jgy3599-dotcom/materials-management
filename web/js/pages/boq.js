// BOQ 검색 화면입니다. 컨베이어 ID로 설계 스펙과 그 설비의 교체(사용) 이력을 함께 보여줍니다.
import { findBoq, getEquipmentHistory, BOQ_LABELS, BOQ_TITLE_FIELD, BOQ_BADGE_FIELDS } from "../db.js";
import { downloadExcel } from "../excel.js";

// 이력 엑셀에 넣을 컬럼 순서입니다. Streamlit 앱의 다운로드와 같게 맞췄습니다.
const HISTORY_COLUMNS = ["일자", "부품명(규격)", "수량", "자재 출처", "문제", "조치", "부품메모", "비고"];

let currentHistory = [];   // 지금 화면에 떠 있는 이력 (정렬·엑셀에 씀)
let currentSearch = "";    // 엑셀 파일명에 쓸 검색어
let sortOrder = "desc";


// DB에서 온 값을 화면에 넣기 전에 특수문자를 무해하게 바꿉니다.
// 비고 같은 자유 입력칸에 <, > 같은 글자가 들어 있어도 화면이 깨지지 않게 하려는 것입니다.
function esc(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function hasValue(v) {
    return v !== null && v !== undefined && String(v).trim() !== "";
}


// 설계 스펙 카드를 그립니다. 값이 없는 항목은 아예 그리지 않아서 화면이 짧아집니다.
function renderSpec(boq) {
    const box = document.getElementById("boq-spec");

    if (!boq) {
        box.innerHTML = `<p class="caption">해당 ID의 BOQ(설계 스펙) 정보가 없습니다.</p>`;
        return;
    }

    const badges = BOQ_BADGE_FIELDS
        .filter((f) => hasValue(boq[f]))
        .map((f) => `<span class="badge-dim">${esc(boq[f])}</span>`)
        .join("");

    const rows = Object.keys(BOQ_LABELS)
        .filter((f) => f !== BOQ_TITLE_FIELD && !BOQ_BADGE_FIELDS.includes(f) && hasValue(boq[f]))
        .map((f) => `
            <div class="spec-row">
                <span class="spec-label">${esc(BOQ_LABELS[f])}</span>
                <span class="spec-value">${esc(boq[f])}</span>
            </div>`)
        .join("");

    box.innerHTML = `
        <h2 class="spec-title">${esc(boq[BOQ_TITLE_FIELD])}</h2>
        <div class="badge-row">${badges}</div>
        ${rows || '<p class="caption">표시할 스펙 항목이 없습니다.</p>'}`;
}


// 교체 이력을 타임라인 형태로 그립니다. 값이 없는 줄은 빼서 한 건이 짧게 보이도록 했습니다.
function renderHistory() {
    const listBox = document.getElementById("boq-history-list");
    const countBox = document.getElementById("boq-history-count");
    const excelBtn = document.getElementById("boq-excel-btn");

    countBox.textContent = `${currentHistory.length}건`;
    excelBtn.disabled = currentHistory.length === 0;

    if (currentHistory.length === 0) {
        listBox.innerHTML = `<p class="caption">이 설비의 교체 이력이 없습니다.</p>`;
        return;
    }

    const sorted = [...currentHistory].sort((a, b) =>
        sortOrder === "desc"
            ? String(b.일자).localeCompare(String(a.일자))
            : String(a.일자).localeCompare(String(b.일자)),
    );

    listBox.innerHTML = sorted.map((h) => {
        const part = hasValue(h["부품명(규격)"])
            ? `${esc(h["부품명(규격)"])}${hasValue(h.수량) ? ` × ${esc(h.수량)}` : ""}`
            : "";
        return `
            <div class="timeline-item">
                <div class="t-date">${esc(h.일자)}</div>
                ${hasValue(h.문제) ? `<div class="t-line"><span class="t-key">문제</span>${esc(h.문제)}</div>` : ""}
                ${hasValue(h.조치) ? `<div class="t-line"><span class="t-key">조치</span>${esc(h.조치)}</div>` : ""}
                ${part ? `<div class="t-line"><span class="t-key">부품</span>${part}</div>` : ""}
                ${hasValue(h.부품메모) ? `<div class="t-line"><span class="t-key">메모</span>${esc(h.부품메모)}</div>` : ""}
                <div class="t-foot">
                    ${hasValue(h["자재 출처"]) ? `<span>📦 ${esc(h["자재 출처"])}</span>` : ""}
                    ${hasValue(h.비고) ? `<span>📝 ${esc(h.비고)}</span>` : ""}
                </div>
            </div>`;
    }).join("");
}


function setStatus(message, isError = false) {
    const box = document.getElementById("boq-status");
    box.textContent = message;
    box.className = isError ? "error-msg" : "caption";
    box.classList.toggle("hidden", !message);
}


export async function search(rawInput) {
    const term = (rawInput ?? "").trim();
    if (!term) return;

    currentSearch = term;
    setStatus("찾는 중...");
    document.getElementById("boq-result").classList.add("hidden");

    try {
        // 스펙이 없어도(BOQ에 애초에 없는 설비) 교체이력은 있을 수 있으므로,
        // 스펙 검색과 이력 검색을 서로 상관없이 각각 진행합니다.
        const boq = await findBoq(term);

        // 스펙을 찾았으면 이력 검색에는 "검색어"가 아니라 "BOQ에서 찾은 컨베이어 ID"를 씁니다.
        // PLC 그룹 포함 형태로 검색했더라도 이력은 PLC 없는 원래 ID로 남아 있기 때문입니다.
        const equipmentId = boq ? boq.conveyor_id : term;

        currentHistory = await getEquipmentHistory(equipmentId);

        renderSpec(boq);
        renderHistory();
        setStatus("");
        document.getElementById("boq-result").classList.remove("hidden");
    } catch (err) {
        setStatus(`조회에 실패했습니다. (${err.message ?? err})`, true);
    }
}


// 화면이 처음 만들어질 때 한 번 불러서 버튼 동작을 연결합니다.
export function init() {
    const input = document.getElementById("boq-input");

    document.getElementById("boq-search-btn").addEventListener("click", () => search(input.value));
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") search(input.value);
    });

    document.getElementById("boq-sort").addEventListener("change", (e) => {
        sortOrder = e.target.value;
        renderHistory();
    });

    document.getElementById("boq-excel-btn").addEventListener("click", async () => {
        await downloadExcel(currentHistory, HISTORY_COLUMNS, `${currentSearch}_교체이력.xlsx`);
    });
}
