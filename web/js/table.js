// 모든 화면이 함께 쓰는 표 컴포넌트입니다.
// Streamlit 앱의 filterable_table()에 해당합니다.
//
// Tabulator를 쓰는 이유: 컬럼 제목 아래에 필터 입력칸이 붙고(엑셀 필터 줄과 비슷),
// 정렬·너비조절·행선택이 기본으로 들어 있어 AgGrid와 사용감이 비슷합니다.
// 게다가 화면에 보이는 부분만 그려서, 수천 건짜리 표도 느려지지 않습니다.
import { TabulatorFull as Tabulator } from "https://cdn.jsdelivr.net/npm/tabulator-tables@6/dist/js/tabulator_esm.min.js";
import { downloadExcel } from "./excel.js";
import { esc } from "./ui.js";


// 상태값을 성격별로 나눕니다. 표를 훑을 때 "끝난 것"과 "아직 할 일이 남은 것"이
// 구분돼야 눈이 갈 데를 찾습니다. 여기 없는 값은 색 없이 그대로 나옵니다.
//
// 노랑(--mark)은 쓰지 않습니다. 그 색은 "지금 여기"와 "확인 필요"를 가리키는 신호로
// 아껴두고 있는데, 표에 수백 칸이 노랗게 깔리면 그 뜻이 묻힙니다.
const STATUS_KIND = {
    // 끝남
    "입고완료": "done",
    "복귀완료": "done",
    // 멈춤
    "반려됨": "stop",
    // 진행 중 (아직 누군가 해야 할 일이 남음)
    "요청됨": "open",
    "검토중": "open",
    "승인됨": "open",
    "구매중": "open",
    "수리중": "open",
    "일부 복귀": "open",
};

// 화면에서 필터·정렬한 결과를 그대로 엑셀로 내보내기 위해, 만든 표를 기억해둡니다.
const tables = new Map();


// 그 칸이 어떤 성격인지 값들을 보고 정합니다. 화면마다 컬럼 목록을 따로 적어두면
// 나중에 컬럼이 늘 때 빠뜨리기 쉬워서, 표가 알아서 판단하게 했습니다.
//
//   number : 전부 숫자. 크기를 견주는 값이라 오른쪽에 자릿수를 맞춥니다.
//   code   : 발주코드·창고번호처럼 숫자가 섞인 식별자. 읽기만 편하게 코드 글꼴을 씁니다.
//            크기를 견주는 값이 아니라 오른쪽으로 밀지는 않습니다.
//   text   : 그 외. 손대지 않습니다.
//
// 행이 수천 개일 수 있어 앞쪽 일부만 봅니다. 성격을 가리는 데는 그 정도면 충분합니다.
function columnKind(rows, name) {
    const values = [];
    for (const row of rows) {
        const v = row[name];
        if (v !== null && v !== undefined && String(v).trim() !== "") values.push(v);
        if (values.length >= 200) break;
    }
    if (values.length === 0) return "text";

    if (values.every((v) => typeof v === "number")) return "number";

    // 한글이 두 글자 이상 이어지면 낱말로 봅니다. 숫자가 섞인 식별자만 코드로 칩니다.
    // 값이 섞여 있을 수 있어 다수결(8할)로 정합니다.
    const codeish = values.filter(
        (v) => /\d/.test(String(v)) && !/[가-힣]{2,}/.test(String(v)),
    );
    return codeish.length >= values.length * 0.8 ? "code" : "text";
}


// 값의 종류가 적은 칸은 같은 말이 계속 되풀이되는 부수 정보입니다
// (카테고리, 거래처, 설치위치처럼). 한 단계 흐리게 해서, 정작 찾는 값이 도드라지게 합니다.
// 줄 수가 적으면 판단할 근거가 부족하므로 8줄 이상일 때만 봅니다.
function isRepetitive(rows, name) {
    const seen = new Set();
    let count = 0;
    for (const row of rows) {
        const v = row[name];
        if (v === null || v === undefined || String(v).trim() === "") continue;
        seen.add(String(v));
        if (++count >= 200) break;
    }
    return count >= 8 && seen.size <= count * 0.3;
}


// '구매필요'가 양수면 그만큼 모자라다는 뜻이라 눈에 띄어야 합니다.
// 0 이하는 채워져 있다는 뜻이니 흐리게 둡니다.
function shortageFormatter(cell) {
    const value = cell.getValue();
    if (value === null || value === undefined || value === "") return "";
    const n = Number(value);
    const text = esc(value);
    if (!Number.isFinite(n)) return text;
    return n > 0 ? `<span class="short">${text}</span>` : `<span class="enough">${text}</span>`;
}


// '상태' 칸을 그립니다. DB에서 온 값이라 화면에 넣기 전에 특수문자를 무해하게 바꿉니다.
function statusFormatter(cell) {
    const value = cell.getValue();
    if (value === null || value === undefined || String(value).trim() === "") return "";

    const text = esc(value);
    const kind = STATUS_KIND[String(value).trim()];
    return kind ? `<span class="status status-${kind}">${text}</span>` : text;
}


// 현재재고가 음수면 실제로 있는 것보다 더 많이 나간 것이라, 기록 어딘가가 어긋났다는
// 신호입니다. 지금도 음수인 자재가 있어서 막지는 않지만, 눈에는 띄어야 합니다.
function stockFormatter(cell) {
    const value = cell.getValue();
    if (value === null || value === undefined || value === "") return "";
    const n = Number(value);
    const text = esc(value);
    return Number.isFinite(n) && n < 0 ? `<span class="negative">${text}</span>` : text;
}


// 값을 그대로 두지 않고 따로 그리는 칸들입니다. 컬럼 이름은 화면이 달라도 같아서
// 여기 한 곳에 모아둡니다. 여기 없는 칸은 손대지 않습니다.
const FORMATTERS = {
    "상태": statusFormatter,
    "구매필요": shortageFormatter,
    "현재재고": stockFormatter,
};

// 이 표에서 실제로 찾는 대상입니다. 다른 칸을 흐리게 하는 것만으로는 부족해서
// 이쪽은 조금 또렷하게 둡니다.
const PRIMARY_COLUMNS = ["부품명(규격)"];


// 칸에 붙일 css 클래스를 정합니다.
function cellClasses(rows, name, kind) {
    const classes = [];
    if (kind !== "text") classes.push("cell-mono");
    if (PRIMARY_COLUMNS.includes(name)) classes.push("cell-primary");
    // 숫자는 이미 오른쪽 자릿수 맞춤으로 구분되니 흐리게 하지 않습니다.
    else if (kind === "text" && isRepetitive(rows, name)) classes.push("cell-dim");
    return classes.length ? classes.join(" ") : undefined;
}


// 표를 그립니다.
//   elementId : 표를 넣을 자리의 id
//   rows      : {컬럼명: 값} 형태의 객체 배열
//   columns   : 보여줄 컬럼 이름 배열 (순서대로)
//   options   : { pageSize, selectable, onRowClick, onRowDblClick }
//
// onRowClick은 한 번 눌렀을 때, onRowDblClick은 두 번 눌렀을 때 불립니다.
// 값을 고치는 창처럼 잘못 열리면 곤란한 것은 두 번 누르기를 씁니다.
export function renderTable(elementId, rows, columns, options = {}) {
    const { pageSize = 25, selectable = false, onRowClick = null, onRowDblClick = null } = options;

    // 같은 자리에 다시 그릴 때는 이전 표를 정리합니다. 안 그러면 겹쳐 쌓입니다.
    if (tables.has(elementId)) {
        tables.get(elementId).destroy();
        tables.delete(elementId);
    }

    const table = new Tabulator(`#${elementId}`, {
        data: rows,
        // fitDataStretch는 남는 폭을 마지막 칸에 몰아줘서, 컬럼이 적은 표에서 끝 칸만
        // 터무니없이 넓어집니다. fitDataFill은 칸을 내용에 맞추고 남는 폭은 빈 자리로 둡니다.
        layout: "fitDataFill",
        placeholder: "표시할 데이터가 없습니다",

        // 스크롤 대신 페이지로 나눠 보여줍니다.
        // 스크롤 방식은 "화면에 보이는 행만 그리는" 계산을 하는데, 표의 크기를 잘못 재면
        // 행이 하나도 안 그려지는 문제가 있었습니다. 페이지 방식은 한 쪽 분량만 그리므로
        // 그 계산 자체가 필요 없어 훨씬 안정적이고, 첫 표시도 빠릅니다.
        pagination: true,
        paginationSize: pageSize,
        paginationSizeSelector: [25, 50, 100, 200],
        paginationCounter: "rows",

        selectableRows: selectable ? 1 : false,
        columns: columns.map((name) => {
            const kind = columnKind(rows, name);
            return {
                title: name,
                field: name,
                headerFilter: "input",       // 컬럼 제목 아래 필터 입력칸
                headerFilterPlaceholder: "검색",
                resizable: true,
                headerSort: true,
                // 내용이 짧아도 이만큼은 줍니다. 안 그러면 id 같은 칸이 너무 좁아져
                // 아래 필터 입력칸에 글자가 다 안 들어갑니다.
                minWidth: 84,
                // 숫자는 오른쪽에 자릿수를 맞춥니다. 왼쪽에 붙어 있으면 100과 5 중
                // 어느 쪽이 큰지 한눈에 안 들어옵니다.
                hozAlign: kind === "number" ? "right" : "left",
                headerHozAlign: kind === "number" ? "right" : "left",
                cssClass: cellClasses(rows, name, kind),
                // 몇몇 칸은 값을 그대로 두지 않고 성격이 드러나게 그립니다.
                //   상태     : 값 앞에 작은 색점
                //   구매필요 : 모자란 쪽만 눈에 띄게
                formatter: FORMATTERS[name],
            };
        }),

        locale: "ko",
        langs: {
            ko: {
                pagination: {
                    first: "«", first_title: "첫 페이지",
                    last: "»", last_title: "마지막 페이지",
                    prev: "이전", prev_title: "이전 페이지",
                    next: "다음", next_title: "다음 페이지",
                    all: "전체",
                    page_size: "표시 개수",
                    page_title: "쪽",
                    counter: { showing: "", of: "/", rows: "건", pages: "페이지" },
                },
                data: { loading: "불러오는 중...", error: "오류가 났습니다" },
            },
        },
    });

    if (onRowClick) {
        table.on("rowClick", (_e, row) => onRowClick(row.getData()));
    }

    if (onRowDblClick) {
        table.on("rowDblClick", (_e, row) => onRowDblClick(row.getData()));
    }

    // 표를 다 만든 뒤에 한 번 다시 그립니다.
    // 화면에 보이는 행만 그리는 방식이라, 만드는 시점에 표의 크기를 잘못 재면 행이 하나도
    // 안 그려집니다(머리글과 스크롤바만 보이고 안이 비어 보임). 브라우저가 배치를 끝낸
    // 다음 다시 그리게 해서 이걸 막습니다.
    table.on("tableBuilt", () => {
        requestAnimationFrame(() => table.redraw(true));

        // 칸 너비는 글자를 실제로 재서 정해집니다. 그런데 웹에서 받아오는 글꼴은 표보다
        // 늦게 도착할 수 있어서, 그 전에 재면 좁게 굳은 채로 값이 잘립니다
        // (날짜가 "2026-07-…"로 나오던 문제). 글꼴이 다 온 뒤에 한 번 더 재게 합니다.
        document.fonts?.ready.then(() => table.redraw(true));
    });

    tables.set(elementId, table);
    return table;
}


// 숨겨져 있던 표가 다시 보이게 됐을 때 부릅니다.
// 숨어 있는 동안에는 크기가 0이라, 그대로 두면 역시 행이 안 그려집니다.
export function redrawTable(elementId) {
    const table = tables.get(elementId);
    if (table) requestAnimationFrame(() => table.redraw(true));
}


// 지금 화면에 보이는(필터·정렬된) 내용을 그대로 엑셀로 내려받습니다.
// 화면과 다운로드 결과가 서로 다른 일이 없도록 표에서 직접 가져옵니다.
export async function downloadTableExcel(elementId, columns, fileName) {
    const table = tables.get(elementId);
    if (!table) return;
    const rows = table.getData("active");   // "active" = 필터·정렬이 적용된 결과
    await downloadExcel(rows, columns, fileName);
}


export function getTableRowCount(elementId) {
    const table = tables.get(elementId);
    return table ? table.getData("active").length : 0;
}
