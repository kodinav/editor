import { useState } from 'react';
import { hitTest } from '@/core/geometry';
import { createEffect } from '@/core/effects';
import * as A from '@/state/actions';
import { addAssetsToTimeline } from '@/state/importer';
import { editor } from '@/state/store';
import { usePreviewInfo } from '@/playback/player';
import { isInternalDrag, readDrag } from '../dnd';

/**
 * Drop target over the preview: media/text/shapes are added at the playhead;
 * effects and filters apply to the layer under the pointer.
 */
export function usePreviewDrop() {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!isInternalDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        setOver(false);
        const p = readDrag(e);
        if (!p) return;
        e.preventDefault();
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const W = editor().project.settings.width;
        const k = r.width / W;
        const pt = { x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k };
        const under = [...usePreviewInfo.getState().bounds.entries()].reverse().find(([, g]) => hitTest(g, pt))?.[0];
        switch (p.kind) {
          case 'assets':
            addAssetsToTimeline(p.ids);
            break;
          case 'text':
            A.addTextPreset(p.preset);
            break;
          case 'shape':
            A.addShape(p.shape, { fullFrame: p.fullFrame, fill: p.fill, fill2: p.fill2 });
            break;
          case 'adjustment':
            A.addAdjustmentLayer();
            break;
          case 'effect':
            if (under) {
              editor().commit('Add effect', (d) => {
                const c = d.clips[under];
                if (c && 'effects' in c) c.effects.push(createEffect(p.type));
              });
              editor().select([under]);
            } else A.applyEffectToSelection(p.type);
            break;
          case 'filter':
            A.applyFilterPreset(p.id, under ? [under] : editor().selection);
            if (under) editor().select([under]);
            break;
          case 'transition':
            A.addTransitionToSelection(p.type);
            break;
        }
      },
    },
  };
}
