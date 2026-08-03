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
//   options   : { height, selectable, onRowClick }
export function renderTable(elementId, rows, columns, options = {}) {
    const { height = "520px", selectable = false, onRowClick = null } = options;

    // 같은 자리에 다시 그릴 때는 이전 표를 정리합니다. 안 그러면 겹쳐 쌓입니다.
    if (tables.has(elementId)) {
        tables.get(elementId).destroy();
        tables.delete(elementId);
    }

    const table = new Tabulator(`#${elementId}`, {
        data: rows,
        height,
        layout: "fitDataStretch",
        placeholder: "표시할 데이터가 없습니다",
        // 화면에 보이는 행만 그려서 큰 표도 빠르게 뜹니다.
        renderVertical: "virtual",
        selectableRows: selectable ? 1 : false,
        columns: columns.map((name) => ({
            title: name,
            field: name,
            headerFilter: "input",       // 컬럼 제목 아래 필터 입력칸
            headerFilterPlaceholder: "검색",
            resizable: true,
            headerSort: true,
        })),
    });

    if (onRowClick) {
        table.on("rowClick", (_e, row) => onRowClick(row.getData()));
    }

    tables.set(elementId, table);
    return table;
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
