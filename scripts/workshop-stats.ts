// npm run workshop-stats [-- <统计文件>]（P8）：只读地汇总关卡工坊的统计，按六类最终结果输出计数。
// 默认读 MW_WORKSHOP_STATS，没设时读 .local/workshop-stats.jsonl。不改任何文件。

import { formatSummary, summarizeFile } from '../server/stats';

const path = process.argv[2] ?? process.env.MW_WORKSHOP_STATS ?? '.local/workshop-stats.jsonl';
const summary = await summarizeFile(path);
console.log(`统计文件：${path}`);
console.log(formatSummary(summary));
