// 浏览器入口（src/main.ts）最先加载这个模块（F6）：在其他模块求值之前决定当前语言，
// 这样模块顶层用 t() 算出来的文字（例如按钮名、常量）也是当前语言的。

import { startLang } from './browser';

startLang();
