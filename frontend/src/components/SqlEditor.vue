<script setup lang="ts">
import { sql } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = defineProps<{
  modelValue: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'run'): void;
}>();

const editorEl = ref<HTMLDivElement | null>(null);
let view: EditorView | null = null;

onMounted(() => {
  if (!editorEl.value) return;

  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      keymap.of(defaultKeymap),
      sql(),
      oneDark,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          emit('update:modelValue', update.state.doc.toString());
        }
      }),
      EditorView.theme({
        '&': { fontSize: '13px', borderRadius: '0.75rem', overflow: 'hidden' },
        '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', minHeight: '140px' },
      }),
    ],
  });

  view = new EditorView({ state, parent: editorEl.value });
});

watch(
  () => props.modelValue,
  (nextVal) => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (nextVal !== current) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: nextVal },
      });
    }
  }
);

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});
</script>

<template>
  <div class="space-y-3">
    <div ref="editorEl" class="overflow-hidden rounded-xl border border-slate-800"></div>
    <div class="flex items-center justify-between">
      <p class="text-xs text-slate-400">
        Protected by AST SQL Firewall — only read-only <code class="text-indigo-300">SELECT</code> statements execute.
      </p>
      <button
        type="button"
        @click="$emit('run')"
        class="rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
      >
        Run Edited SQL
      </button>
    </div>
  </div>
</template>
