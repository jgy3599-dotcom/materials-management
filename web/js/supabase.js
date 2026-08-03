// Supabase에 접속하는 객체를 만들어 다른 파일들이 가져다 쓰게 합니다.
//
// 빌드 과정(npm 등) 없이 쓰려고 CDN에서 바로 불러옵니다. 회사 네트워크가 CDN을 막으면
// 이 줄에서 실패하는데, 그때는 라이브러리 파일을 web/vendor/ 에 직접 넣고 경로만 바꾸면 됩니다.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
        // 로그인 상태를 브라우저에 저장해서, 새로고침하거나 창을 닫았다 열어도 유지되게 합니다.
        persistSession: true,
        autoRefreshToken: true,
    },
});


// 서버까지 실제로 닿는지 확인합니다.
//
// fetch로 직접 부르지 않고 supabase 클라이언트를 쓰는 이유: Supabase는 apikey 말고
// Authorization 헤더도 함께 요구하는데, 라이브러리가 그걸 알아서 붙여줍니다.
// 게다가 실제 화면들이 쓸 경로와 같아져서 더 의미 있는 검사가 됩니다.
//
// 로그인 전에는 RLS가 막아서 데이터가 0건으로 나오는데, 그게 정상입니다.
// 여기서 확인하려는 건 "데이터가 있는가"가 아니라 "서버까지 닿는가"입니다.
export async function checkConnection() {
    const { error } = await supabase.from("materials").select("id").limit(1);
    if (error) {
        throw new Error(`${error.message}${error.code ? ` (코드 ${error.code})` : ""}`);
    }
    return true;
}
