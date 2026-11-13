"""Build anonymous, self-contained previews of calendar integration and settings."""
from pathlib import Path
import json
import re

root = Path(__file__).resolve().parent.parent
preview = root / "artifacts" / "preview"
preview.mkdir(parents=True, exist_ok=True)
read = lambda name: (root / name).read_text(encoding="utf-8")
fixtures = {key: read("tests/fixtures/" + name) for key, name in [
    ("assignments", "nespa-assignments.html"), ("complete", "nespa-submission-complete.html"), ("empty", "nespa-submission-empty.html")
]}

def inline(source):
    return "<script>" + source.replace("</script", "<\\/script") + "</script>"

mock = "globalThis.peFixtures=" + json.dumps(fixtures, ensure_ascii=False) + ";\n" + r"""
(() => {
  Date.now=()=>Date.parse('2026-10-30T12:00:00+09:00');
  const values={},listeners=new Set();
  globalThis.pePreviewSession=true;
  globalThis.pePreviewMessages=[];
  globalThis.chrome={storage:{local:{
    get(key,callback){const result=typeof key==='string'?{[key]:values[key]}:{...values};callback?.(result);return Promise.resolve(result);},
    set(patch,callback){const changes={};for(const[key,value]of Object.entries(patch)){changes[key]={oldValue:values[key],newValue:value};values[key]=value;}listeners.forEach(fn=>fn(changes,'local'));callback?.();return Promise.resolve();}
  },onChanged:{addListener(fn){listeners.add(fn);},removeListener(fn){listeners.delete(fn);}}},runtime:{
    sendMessage(message,callback){
      pePreviewMessages.push(message);
      const result=!pePreviewSession?{ok:false,error:'auth-required',message:'NESPA에서 직접 로그인한 뒤 PLATO 달력을 새로고침해 주세요.'}:
        message.type==='PE_NESPA_FETCH'?{ok:true,html:message.resource==='assignments'?peFixtures.assignments:message.problemId==='001'?peFixtures.complete:peFixtures.empty,fetchedAt:Date.now()}:{ok:false};
      queueMicrotask(()=>callback?.(result));return Promise.resolve(result);
    }
  }};
})();
"""
files = ['config.js','nespa-settings.js','plato-parser.js','submission-parser.js','storage.js','data-source.js',
         'nespa-parser.js','nespa-data-source.js','combined-data-source.js','calendar-model.js','activity-modal.js','calendar-view.js']
mount = r"""
(async () => {
  const ns=globalThis.PlatoCalendarExt;
  const native=document.querySelector('#pw-nav-channel').innerHTML;
  document.addEventListener(ns.config.requestEvent,event=>{
    const request=JSON.parse(event.detail),context={userId:'preview',timezone:'Asia/Seoul'};
    const payload=request.operation==='context'?context:{context,month:{events:[]},action:{complete:true}};
    document.dispatchEvent(new CustomEvent(ns.config.responseEvent,{detail:JSON.stringify({requestId:request.requestId,ok:true,payload})}));
  });
  globalThis.pePreview=new ns.CalendarView();
  await pePreview.mount(document.querySelector('#native-courses'));
  globalThis.pePreviewDiagnostics=()=>({
    ready:!pePreview.loading,
    nativeMenuPreserved:document.querySelector('#pw-nav-channel').innerHTML===native,
    pageOverflow:document.documentElement.scrollWidth>innerWidth,
    taskCount:pePreview.activities.filter(item=>item.provider==='nespa').length,
    addedMenus:document.querySelectorAll('#pe-navigation-nespa,#pe-navigation-settings,#pe-nespa-workspace').length,
    viewChangedOnNespa:document.querySelectorAll('.pe-nespa-enabled,.pe-nespa-rail,.pe-nespa-topbar').length,
    messages:pePreviewMessages.map(message=>message.type)
  });
  document.body.dataset.previewReady='true';
  addEventListener('pagehide',event=>{if(!event.persisted)pePreview.destroy();});
})();
"""
rail = ''.join(f'<li><a class="btn-channel nav-link" href="https://plato.pusan.ac.kr/"><span>{label}</span></a></li>' for label in ['홈','교과과정','지정강좌','교수·학습','자율강좌','산지니 AI','메시지'])
shell = f'''<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PLATO 달력 연동 미리보기</title><style>{read('tests/fixtures/plato-preview.css')}</style><style>{read('styles/calendar.css')}</style></head><body><nav id="pw-nav-channel"><div class="moremenu"><ul>{rail}</ul></div></nav><aside id="pw-nav-menu"><div class="my-courses">부산대학교</div><div class="menu-container"><h2>홈</h2><a href="#" class="active">내 강좌</a><a href="#">전체 공지사항</a></div></aside><header id="pw-header">홈 › 내 강좌</header><div id="page"><div id="page-content"><main id="region-main"><h1 class="preview-native-title">내 강좌</h1><section id="native-courses" class="preview-native-card"><h2>내 강좌</h2><p>익명 예시 데이터입니다. NESPA 화면 변경이나 자동 로그인은 실행하지 않습니다.</p></section></main></div></div>'''
page = shell + inline(mock) + ''.join(inline(read('src/'+file)) for file in files) + inline(mount) + '</body></html>'
for name in ['plato.html','offline-plato.html']:
    (preview/name).write_text(page, encoding='utf-8')

options = read('options.html')
options = options.replace('<link rel="stylesheet" href="styles/options.css">', '<style>'+read('styles/options.css')+'</style>')
options = re.sub(r'<script src="[^"]+" defer></script>', '', options)
options = options.replace('</body>', inline(mock) + inline(read('src/nespa-settings.js')) + inline(read('options.js')) + '</body>')
(preview/'options.html').write_text(options, encoding='utf-8')
(preview/'index.html').write_text('<!doctype html><html lang="ko"><meta charset="utf-8"><title>달력 연동 미리보기</title><h1>PLATO 달력 연동</h1><p>익명 예시 데이터로만 동작합니다.</p><ul><li><a href="plato.html">달력</a></li><li><a href="options.html">연동 설정</a></li></ul></html>', encoding='utf-8')
print(preview/'index.html')
