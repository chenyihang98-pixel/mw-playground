// 开发工具入口（只在开发和测试模式下动态加载）：夹具预览、预览面板、测试钩子。

import { DEFAULT_PREVIEW_FIXTURE, FIXTURES, isFixtureId } from '../asset/fixtures';
import type { SceneApp } from '../scene/createScene';
import { FixturePreview, type PreviewState } from './fixturePreview';
import { installTestHooks } from './testHooks';

function describeLoop(clip: PreviewState['clips'][number]): string {
  return clip.hasLoop ? `userData.loop = ${JSON.stringify(clip.loop)}` : 'userData 里没有 loop';
}

function createPanel(preview: FixturePreview): void {
  const panel = document.createElement('div');
  panel.id = 'dev-panel';

  const title = document.createElement('div');
  title.textContent = '夹具预览（开发）';
  title.style.fontWeight = '600';

  const fixtureSelect = document.createElement('select');
  fixtureSelect.setAttribute('aria-label', '夹具');
  for (const f of FIXTURES.filter((x) => x.previewable)) {
    fixtureSelect.add(new Option(`${f.id} — ${f.title}`, f.id, f.id === DEFAULT_PREVIEW_FIXTURE, f.id === DEFAULT_PREVIEW_FIXTURE));
  }
  fixtureSelect.addEventListener('change', () => {
    const id = fixtureSelect.value;
    if (isFixtureId(id)) {
      preview.load(id).catch((error: unknown) => {
        console.error('夹具加载失败', error);
      });
    }
  });

  const clipSelect = document.createElement('select');
  clipSelect.setAttribute('aria-label', '片段');
  clipSelect.addEventListener('change', () => {
    preview.play(Number(clipSelect.value));
  });

  const status = document.createElement('div');

  panel.append(title, fixtureSelect, document.createElement('br'), clipSelect, status);
  document.body.append(panel);

  let lastFixture: string | null = null;
  preview.subscribe((state) => {
    if (state.fixtureId !== lastFixture) {
      lastFixture = state.fixtureId;
      clipSelect.replaceChildren(...state.clips.map((c, i) => new Option(`${i}: ${c.name}`, String(i))));
    }
    if (state.activeClip !== null) clipSelect.value = String(state.activeClip);
    const active = state.activeClip === null ? undefined : state.clips[state.activeClip];
    status.textContent =
      state.status === 'error'
        ? `加载失败：${state.error ?? ''}`
        : state.status === 'loading'
          ? '加载中…'
          : active
            ? `${active.name}（${active.duration.toFixed(2)} s，${describeLoop(active)}）`
            : '没有动画片段';
  });
}

export function startDevTools(app: SceneApp): void {
  const preview = new FixturePreview(app.scene);
  app.onFrame((delta) => {
    preview.update(delta);
  });
  createPanel(preview);
  installTestHooks(app, preview, import.meta.env.MODE);
  preview.load(DEFAULT_PREVIEW_FIXTURE).catch((error: unknown) => {
    console.error('默认夹具加载失败', error);
  });
}
