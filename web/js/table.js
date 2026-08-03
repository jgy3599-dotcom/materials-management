// 모든 화면이 함께 쓰는 표 컴포넌트입니다.
// Streamlit 앱의 filterable_table()에 해당합니다.
//
// Tabulator를 쓰는 이유: 컬럼 제목 아래에 필터 입력칸이 붙고(엑셀 필터 줄과 비슷),
// 정렬·너비조절·행선택이 기본으로 들어 있어 AgGrid와 사용감이 비슷합니다.
// 게다가 화면에 보이는 부분만 그려서, 수천 건짜리 표도 느려지지 않습니다.
import { TabulatorFull as Tabulator } from "https://cdn.jsdelivr.net/npm/tabulator-tables@6/dist/js/tabulator_esm.min.js";
import { downloadExcel } from "./excel.js";

// 화면에서 필터·정렬한 결과를 그대로 엑셀로 내보내기 위해, 만든 표를 기억해둡니다.
const tables = new Map();


// 표를 그립니다.
//   elementId : 표를 넣을 자리의 id
//   rows      : {컬럼명: 값} 형태의 객체 배열
//   columns   : 보여줄 컬럼 이름 배열 (순서대로)
//   options   : { pageSize, selectable, onRowClick }
export function renderTable(elementId, rows, columns, options = {}) {
    const { pageSize = 50, selectable = false, onRowClick = null } = options;

    // 같은 자리에 다시 그릴 때는 이전 표를 정리합니다. 안 그러면 겹쳐 쌓입니다.
    if (tables.has(elementId)) {
        tables.get(elementId).destroy();
        tables.delete(elementId);
    }

    const table = new Tabulator(`#${elementId}`, {
        data: rows,
        layout: "fitDataStretch",
        placeholder: "표시할 데이터가 없습니다",

        // 스크롤 대신 페이지로 나눠 보여줍니다.
        // 스크롤 방식은 "화면에 보이는 행만 그리는" 계산을 하는데, 표의 크기를 잘못 재면
        // 행이 하나도 안 그려지는 문제가 있었습니다. 페이지 방식은 한 번에 50줄만 그리므로
        // 그 계산 자체가 필요 없어 훨씬 안정적이고, 첫 표시도 빠릅니다.
        pagination: true,
        paginationSize: pageSize,
        paginationSizeSelector: [25, 50, 100, 200],
        paginationCounter: "rows",

        selectableRows: selectable ? 1 : false,
        columns: columns.map((name) => ({
            title: name,
            field: name,
            headerFilter: "input",       // 컬럼 제목 아래 필터 입력칸
            headerFilterPlaceholder: "검색",
            resizable: true,
            headerSort: true,
        })),

        locale: "ko",
        langs: {
            ko: {
                pagination: {
                    first: "«", first_title: "첫 페이지",
                    last: "»", last_title: "마지막 페이지",
                    prev: "이전", prev_title: "이전 페이지",
                    next: "다음", next_title: "다음 페이지",
                    all: "전체",
                    counter: { showing: "", of: "/", rows: "건", pages: "페이지" },
                },
                data: { loading: "불러오는 중...", error: "오류가 났습니다" },
            },
        },
    });

    if (onRowClick) {
        table.on("rowClick", (_e, row) => onRowClick(row.getData()));
    }

    // 표를 다 만든 뒤에 한 번 다시 그립니다.
    // 화면에 보이는 행만 그리는 방식이라, 만드는 시점에 표의 크기를 잘못 재면 행이 하나도
    // 안 그려집니다(머리글과 스크롤바만 보이고 안이 비어 보임). 브라우저가 배치를 끝낸
    // 다음 다시 그리게 해서 이걸 막습니다.
    table.on("tableBuilt", () => {
        requestAnimationFrame(() => table.redraw(true));
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
