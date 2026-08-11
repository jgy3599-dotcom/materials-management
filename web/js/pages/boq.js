// BOQ 검색 화면입니다. 컨베이어 ID로 설계 스펙과 그 설비의 교체(사용) 이력을 함께 보여줍니다.
import { findBoq, getEquipmentHistory, BOQ_LABELS, BOQ_TITLE_FIELD, BOQ_BADGE_FIELDS } from "../db.js";
import { downloadExcel } from "../excel.js";

// 이력 엑셀에 넣을 컬럼 순서입니다. Streamlit 앱의 다운로드와 같게 맞췄습니다.
const HISTORY_COLUMNS = ["일자", "부품명(규격)", "수량", "자재 출처", "문제", "조치", "부품메모", "비고"];

let currentHistory = [];   // 지금 화면에 떠 있는 이력 (정렬·엑셀에 씀)
let currentSearch = "";    // 엑셀 파일명에 쓸 검색어
let searchSeq = 0;         // 검색마다 매기는 번호 (늦게 온 이전 결과를 버리는 데 씀)
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


// 명판에 따로 표시하는 항목들입니다. 아래 스펙 목록에서는 빠집니다.
const PLATE_FIELDS = ["conveyor_id", "conveyor_id_with_plc", "location_1", "location_2"];


// DB에 저장된 값을 사람이 쓰는 말로 바꿉니다.
// 여기 없는 값은 원본 그대로 나오니, 화면에서 낯선 코드가 보이면 여기 한 줄 추가하시면 됩니다.
const BADGE_TEXT = {
    branch_roller_conveyor: "분기 롤러 컨베이어",
    "소형all": "소형 전체",
};


// 오른쪽에 자릿수를 맞춰 세울 값인지 봅니다.
// 치수, 규격코드, 비율(1/20)처럼 자릿수 자체가 뜻을 갖는 값이 대상입니다.
// 한글 낱말과 roller 같은 분류명은 여기 걸리지 않아 왼쪽에서 읽히게 됩니다.
function isCode(value) {
    const v = String(value).trim();
    if (v === "" || /[가-힣]{2,}/.test(v)) return false;
    return /\d/.test(v) || !/^[a-z ]+$/.test(v);
}


// PLC 그룹을 떼어냅니다.
// conveyor_id_with_plc("CC101 LM101 BD001")는 conveyor_id("LM101 BD001") 앞에 그룹 코드가
// 붙은 형태라, 앞쪽 남는 부분이 그룹입니다. 그룹이 없는 설비도 있어 그때는 null입니다.
function plcGroupOf(boq) {
    const full = (boq.conveyor_id_with_plc ?? "").trim();
    const id = (boq.conveyor_id ?? "").trim();
    if (!full || !id) return null;

    const fullParts = full.split(/\s+/);
    const idParts = id.split(/\s+/);
    if (fullParts.length <= idParts.length) return null;

    return fullParts.slice(0, fullParts.length - idParts.length).join(" ");
}


// 설계 스펙을 그립니다.
// 위쪽은 설비를 가리키는 코드를 명판처럼 보여주고, 아래는 값이 있는 항목만 줄지어 놓습니다.
// 비어 있는 항목을 지우면 실제로 볼 것만 남아 화면이 훨씬 짧아집니다.
function renderSpec(boq, searchTerm) {
    const plateBox = document.getElementById("boq-plate");
    const box = document.getElementById("boq-spec");

    // 명판은 스펙이 없어도 띄웁니다. BOQ에 없는 설비라도 "무엇을 찾았는지"는 보여야 하고,
    // 아래 교체 이력은 그 ID로 계속 조회하기 때문입니다.
    const plc = boq ? plcGroupOf(boq) : null;
    const idText = boq ? boq[BOQ_TITLE_FIELD] : searchTerm;
    // 위치도 명판에 올립니다. 설비를 가리키는 정보라 스펙 목록보다 여기가 제자리입니다.
    const place = boq
        ? [boq.location_1, boq.location_2].filter((v) => hasValue(v)).join(" ")
        : "";
    plateBox.innerHTML = `
        <div class="plate">
            ${plc ? `
            <div class="plate-field">
                <span class="plate-label">PLC 그룹</span>
                <span class="plate-value">${esc(plc)}</span>
            </div>` : ""}
            <div class="plate-field plate-main">
                <span class="plate-label">컨베이어 ID</span>
                <span class="plate-value">${esc(idText)}</span>
            </div>
            ${place ? `
            <div class="plate-field">
                <span class="plate-label">위치</span>
                <span class="plate-value">${esc(place)}</span>
            </div>` : ""}
        </div>`;

    if (!boq) {
        box.innerHTML = `<p class="caption">해당 ID의 BOQ(설계 스펙) 정보가 없습니다.</p>`;
        return;
    }

    // 같은 값이 두 칸에 들어 있는 자재가 있어 중복을 걷어냅니다.
    const badges = [...new Set(
            BOQ_BADGE_FIELDS.filter((f) => hasValue(boq[f])).map((f) => String(boq[f]).trim())
        )]
        .map((v) => `<span class="badge-dim">${esc(BADGE_TEXT[v] || v)}</span>`)
        .join("");

    const rows = Object.keys(BOQ_LABELS)
        .filter((f) => !PLATE_FIELDS.includes(f) && !BOQ_BADGE_FIELDS.includes(f) && hasValue(boq[f]))
        .map((f) => `
            <div class="spec-row">
                <span class="spec-label">${esc(BOQ_LABELS[f])}</span>
                <span class="${isCode(boq[f]) ? "spec-num" : "spec-text"}">${esc(boq[f])}</span>
            </div>`)
        .join("");

    box.innerHTML = (badges ? `<div class="badge-row">${badges}</div>` : "")
        + (rows
            ? `<div class="spec-grid">${rows}</div>`
            : '<p class="caption">표시할 스펙 항목이 없습니다.</p>');
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
        // 부품명과 수량은 코드용 글꼴로 보여줍니다. 규격에 숫자가 많아 그쪽이 읽기 낫습니다.
        const part = hasValue(h["부품명(규격)"])
            ? `<span class="t-part">${esc(h["부품명(규격)"])}${hasValue(h.수량) ? ` × ${esc(h.수량)}` : ""}</span>`
            : "";
        return `
            <div class="timeline-item">
                <div class="t-date">${esc(h.일자)}</div>
                ${hasValue(h.문제) ? `<div class="t-line"><span class="t-key">문제</span>${esc(h.문제)}</div>` : ""}
                ${hasValue(h.조치) ? `<div class="t-line"><span class="t-key">조치</span>${esc(h.조치)}</div>` : ""}
                ${part ? `<div class="t-line"><span class="t-key">부품</span>${part}</div>` : ""}
                ${hasValue(h.부품메모) ? `<div class="t-line"><span class="t-key">메모</span>${esc(h.부품메모)}</div>` : ""}
                <div class="t-foot">
                    ${hasValue(h["자재 출처"]) ? `<span><span class="t-key">출처</span>${esc(h["자재 출처"])}</span>` : ""}
                    ${hasValue(h.비고) ? `<span><span class="t-key">비고</span>${esc(h.비고)}</span>` : ""}
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

    // ⚠️ 검색을 연달아 하면(엔터 두 번, 또는 사용이력 표의 바로가기 뒤에 손으로 검색)
    // 응답이 보낸 순서와 다르게 도착할 수 있습니다. 그러면 늦게 온 앞 검색 결과가 지금
    // 화면을 덮어쓰는데, currentSearch는 이미 새 검색어라 엑셀 파일명은 B인데 내용은
    // A인 파일이 받아집니다. 번호를 매겨 마지막 검색이 아니면 조용히 버립니다.
    const seq = ++searchSeq;

    currentSearch = term;
    setStatus("찾는 중...");
    document.getElementById("boq-result").classList.add("hidden");
    document.getElementById("boq-plate").innerHTML = "";

    try {
        // 스펙이 없어도(BOQ에 애초에 없는 설비) 교체이력은 있을 수 있으므로,
        // 스펙 검색과 이력 검색을 서로 상관없이 각각 진행합니다.
        const boq = await findBoq(term);
        if (seq !== searchSeq) return;

        // 스펙을 찾았으면 이력 검색에는 "검색어"가 아니라 "BOQ에서 찾은 컨베이어 ID"를 씁니다.
        // PLC 그룹 포함 형태로 검색했더라도 이력은 PLC 없는 원래 ID로 남아 있기 때문입니다.
        const equipmentId = boq ? boq.conveyor_id : term;

        // 검사를 통과한 뒤에 담습니다. 먼저 담으면 버릴 결과가 이미 화면 데이터를 덮어씁니다.
        const history = await getEquipmentHistory(equipmentId);
        if (seq !== searchSeq) return;
        currentHistory = history;

        renderSpec(boq, term);
        renderHistory();
        setStatus("");
        document.getElementById("boq-result").classList.remove("hidden");
    } catch (err) {
        // 버려진 검색의 오류로 새 검색의 "찾는 중..."을 덮지 않습니다.
        if (seq !== searchSeq) return;
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
