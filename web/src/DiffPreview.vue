<script setup>
import { computed } from 'vue';
import { FileCode2 } from '@lucide/vue';
const props = defineProps({ diff: { type: Object, required: true } });
const files = computed(() => (props.diff.status || '').split('\n').filter(Boolean));
</script>

<template>
<div class="diff-area"><div v-if="files.length" class="file-list"><div v-for="file in files" :key="file"><FileCode2 :size="13" /><span>{{ file.slice(3) }}</span><b>{{ file.slice(0, 2).trim() }}</b></div></div><div v-if="diff.diff" class="diff-code"><div v-for="(line, i) in diff.diff.split('\n')" :key="i" :class="{ addition: line.startsWith('+'), deletion: line.startsWith('-'), hunk: line.startsWith('@@') }">{{ line || ' ' }}</div></div><div v-else class="inspector-empty"><span class="empty-icon"><FileCode2 :size="26" stroke-width="1.3" /></span><strong>{{ diff.available ? files.length ? '当前无可展示的文本差异' : '工作区很干净' : '等待代码变更' }}</strong><p>{{ diff.available ? '智能体修改代码后，差异将在这里显示。新增文件可在文件列表查看。' : '当前目录尚未初始化 Git。连接 Git 项目后，即可在这里查看真实代码差异。' }}</p></div><p v-if="diff.truncated" class="context-note">变更内容较长，当前仅展示前 200 KB。</p></div>
</template>
