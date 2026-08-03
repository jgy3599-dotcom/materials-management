// 표를 엑셀 파일로 내려받게 해줍니다.
// Streamlit 앱의 excel_download_button에 해당합니다.
//
// SheetJS는 파일이 커서 필요할 때만 불러옵니다. 이렇게 하면 엑셀을 받지 않는 사람은
// 아예 내려받지 않아 첫 화면이 빨라집니다.
let sheetJs = null;

async function loadSheetJs() {
    if (!sheetJs) {
        sheetJs = await import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm");
    }
    return sheetJs;
}


// rows는 {컬럼명: 값} 형태의 객체 배열입니다. 컬럼 순서는 columns 배열대로 맞춥니다.
export async function downloadExcel(rows, columns, fileName) {
    const XLSX = await loadSheetJs();

    // 컬럼 순서를 지정한 대로 다시 정렬합니다. 값이 없으면 빈 칸으로 둡니다.
    const ordered = rows.map((row) => {
        const out = {};
        for (const col of columns) out[col] = row[col] ?? "";
        return out;
    });

    const sheet = XLSX.utils.json_to_sheet(ordered, { header: columns });
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "Sheet1");
    XLSX.writeFile(book, fileName);
}
