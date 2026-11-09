// e2e 结束后删掉工坊服务写在系统临时目录里的统计文件（P8）。

import { rmSync } from 'node:fs';
import { WORKSHOP_STATS } from '../../playwright.config';

export default function globalTeardown(): void {
  rmSync(WORKSHOP_STATS, { force: true });
}
